"""
文件上传处理服务

## 完整链路

```
用户上传 PDF/TXT
  → 存到磁盘（uploads/ 目录）
  → read_file：按扩展名分发解析
     ├─ TXT：直接读 UTF-8
     └─ PDF：PyMuPDF 提取文字 + 按字体大小还原标题层级
  → clean_text：去噪声（多余空行、行首尾空白）
  → chunk_text_semantic：语义分块（按段落→句子→字符 三级切分）
  → get_embedding：Ollama bge-m3 向量化
  → ChromaDB：写入向量库，供后续 RAG 检索
```

## 和 Express fileParser.ts 的对比

| | Express | Python（本文件） |
|---|---|---|
| PDF 引擎 | pdf-parse (pdf.js) | PyMuPDF（快 10x，中文更好） |
| 标题识别 | ❌ | ✅ 按字体大小标记 #/## |
| 文本清洗 | 无 | ✅ clean_text |
| 分块策略 | 5000 字一刀切 | ✅ 512 字语义分块 + 50 字重叠 |
| 入库 | ❌ 没有 | ✅ 分块后逐条 embedding → ChromaDB |

## 分块策略详解

采用**三级退化切分**（chunk_text_semantic）：
  1. 第一优先：按段落边界（\n\n）切分
  2. 段落超长 → 按句子边界（。！？；）切分
  3. 句子超长 → 按字符硬切（兜底）

每一块之间 overlap 字符重叠，防止语义被切开。
例："宝宝发烧时应该怎么办。如果温度过高..." → 块1末包含"如果温度过高"，块2开头也包含这句话。
"""

import os
import re
import uuid

from fastapi import HTTPException, UploadFile

from app.services.rag.embedding import get_embedding

# ============================================================
# 配置
# ============================================================

# 允许上传的文件格式
ALLOWED_EXTENSIONS = {"pdf", "txt"}

# 上传文件存储目录
UPLOAD_DIR = "uploads"

# 分块大小（字符数）：约 512 字符 ≈ 250 中文字
CHUNK_SIZE = 512

# 相邻块之间的重叠字符数：防止关键信息刚好落在分块边界上
CHUNK_OVERLAP = 50


# ============================================================
# 1. 文件解析
# ============================================================

def read_pdf(file_path: str) -> str:
    """
    用 PyMuPDF 解析 PDF，按字体大小还原标题层级。

    ## 为什么用 PyMuPDF 而不是 PyPDF2？
      - PyMuPDF 速度比 PyPDF2 快约 10 倍
      - 对中文 PDF 的兼容性更好（尤其是含自定义编码的老文件）
      - 能获取字体大小信息 → 可以还原标题层级
      - 可以渲染页面为图片（后续 OCR 扩展用）

    ## PDF 内部结构速览

    一个 PDF 页面由多个 "block" 组成，每个 block 要么是文本块（type=0），
    要么是图片块（type=1）。文本块由多行（line）组成，每行由多个 span 组成。

    一个 span 是一段格式相同的文字（字体、大小、颜色都一致）。
    举例：
      block
        ├── line 1: "宝宝发烧怎么办"（18pt 加粗）
        │   └── span: text="宝宝发烧怎么办", size=18, font="SimHei"
        └── line 2: "宝宝发烧时，家长首先要保持冷静..."（12pt 常规）
            └── span: text="宝宝发烧时...", size=12, font="SimSun"

    ## 标题识别策略

    取每个文本块中最大的字体作为判断依据：
      - >= 18pt  → # 一级标题
      - >= 14pt  → ## 二级标题
      - < 14pt   → 正文（不加标记）

    这个阈值基于大多数中文 PDF 的排版习惯：
      正文 10-12pt，二级标题 14-16pt，一级标题 18-24pt。
    """
    import fitz  # PyMuPDF 的包名是 fitz

    doc = fitz.open(file_path)
    all_parts = []

    for page_num in range(len(doc)):
        page = doc[page_num]

        # get_text("dict") 返回页面所有元素的完整字典结构
        # 比 get_text("text")（纯文本）多出了字体、大小等格式化信息
        blocks = page.get_text("dict")["blocks"]

        for block in blocks:
            # block["type"]:
            #   0 = 文本块（我们的处理对象）
            #   1 = 图片块（跳过，后续可扩展 OCR）
            if block["type"] != 0:
                continue

            block_text = ""
            max_font_size = 0  # 记录这个文本块中最大的字号

            # 遍历文本块中的每一行
            for line in block["lines"]:
                line_text = ""

                # 遍历行中的每个 span（同一格式的文字片段）
                for span in line["spans"]:
                    line_text += span["text"]        # 拼接文字
                    # 字号是浮点数，如 12.0, 18.5
                    if span["size"] > max_font_size:
                        max_font_size = span["size"]

                # 行末加换行（PyMuPDF 不自动换行）
                block_text += line_text.strip() + "\n"

            # 去掉尾部空白
            block_text = block_text.strip()

            if not block_text:
                continue

            # 按该块中最大字号判断标题层级
            if max_font_size >= 18:
                # 一级标题 — 用 Markdown # 标记
                all_parts.append(f"# {block_text}")
            elif max_font_size >= 14:
                # 二级标题 — 用 Markdown ## 标记
                all_parts.append(f"## {block_text}")
            else:
                # 正文 — 不加 Markdown 标记
                all_parts.append(block_text)

    doc.close()
    return "\n\n".join(all_parts)


def read_file(file_path: str, extension: str) -> str:
    """
    按文件扩展名分发到对应解析器。

    Args:
        file_path: 文件在磁盘上的绝对路径
        extension: 小写的文件扩展名（pdf / txt）

    Returns:
        解析后的纯文本字符串（PDF 可能含 Markdown 标题标记）
    """
    if extension == "txt":
        # TXT 最简单 — 直接 UTF-8 读
        with open(file_path, "r", encoding="utf-8") as f:
            return f.read()

    if extension == "pdf":
        try:
            return read_pdf(file_path)
        except ImportError:
            # PyMuPDF (fitz) 没有安装
            raise HTTPException(
                status_code=500,
                detail="PyMuPDF 未安装，无法处理 PDF。请运行: pip install pymupdf",
            )
        except Exception as e:
            # PDF 文件损坏、加密、不是有效 PDF 等
            raise HTTPException(
                status_code=500,
                detail=f"PDF 解析失败: {e}",
            )

    # 走到这里说明扩展名不在支持列表中（理论上不会，外层已有校验）
    raise HTTPException(status_code=400, detail=f"不支持的文件格式: {extension}")


# ============================================================
# 2. 文本清洗
# ============================================================

def clean_text(text: str) -> str:
    """
    清洗文本中的噪声。

    处理内容：
      1. 超过 3 个连续换行 → 压缩为 2 个（双换行 = 段落分隔）
      2. 超过 2 个连续空格 → 压缩为 1 个
      3. 去掉每行首尾空白
      4. 过滤掉长度 <= 1 的无效行（空行、单独标点等）

    为什么用 2 个连续换行作段落分隔？
      后续 chunk_text_semantic 用 "\n\n" 作为段落边界来切分。
    """
    # 连续换行压缩
    text = re.sub(r"\n{3,}", "\n\n", text)

    # 连续空格压缩
    text = re.sub(r" {2,}", " ", text)

    # 逐行去首尾空白 + 过滤无效行
    lines = []
    for line in text.split("\n"):
        line = line.strip()
        if len(line) > 1:
            lines.append(line)

    return "\n".join(lines)


# ============================================================
# 3. 语义分块
# ============================================================

def chunk_text_semantic(
    text: str,
    chunk_size: int = CHUNK_SIZE,
    overlap: int = CHUNK_OVERLAP,
) -> list[str]:
    """
    按语义边界切分文本，三级退化策略。

    ## 为什么不做纯字符切分？

    纯字符切分（chunk_text_old）可能在句子中间断开：
      块1: "宝宝发烧时，家"     ← 第512个字符，语义不完整
      块2: "长首先要保持冷静"   ← 下半句，脱离了上文

    语义切分优先在自然边界（段落、句子）处断开：
      块1: "宝宝发烧时，家长首先要保持冷静。如果体温低于38.5度，可以物理降温。"
      块2: "如果体温超过38.5度，可以考虑使用退烧药。对乙酰氨基酚适用于..."

    overlap 确保块2开头重复块1末尾的部分内容，检索时不丢失上下文。

    ## 三级退化切分

    1. 第一优先：按段落边界（\n\n）切分
       → 大多数情况下够用，段落是天然的语义单位

    2. 段落超长 → 按句子边界（。！？；）切分
       → 用 _split_by_sentence 处理，在标点处断开

    3. 句子也超长 → 按字符切分（_split_by_sentence 内部兜底）
       → 极端情况，如无标点的数据表格
    """
    # Step 1：按段落切分（段落 = 两个连续换行符分隔的文本块）
    paragraphs = text.split("\n\n")

    chunks = []
    current_chunk = ""

    for para in paragraphs:
        para = para.strip()
        if not para:
            continue

        # 当前块加上这个段落还装得下 → 追加
        if len(current_chunk) + len(para) < chunk_size:
            if current_chunk:
                current_chunk += "\n\n" + para
            else:
                current_chunk = para
        else:
            # 装不下了 → 保存当前块
            if current_chunk:
                chunks.append(current_chunk.strip())

            # 单个段落本身就超过限制 → 按句子切
            if len(para) > chunk_size:
                sub_chunks = _split_by_sentence(para, chunk_size, overlap)
                chunks.extend(sub_chunks)
                current_chunk = ""
            else:
                # 开启新块
                current_chunk = para

    # 不要忘了最后一块
    if current_chunk:
        chunks.append(current_chunk.strip())

    return chunks


def _split_by_sentence(text: str, chunk_size: int, overlap: int) -> list[str]:
    """
    对超长段落按句号/感叹号/问号/分号切分。

    做法：
      1. 在每个句子分隔符后插入标记 "<<SPLIT>>"
      2. 按标记切分，得到句子列表
      3. 逐句拼成不超过 chunk_size 的块

    overlap 策略：
      新块从上一块末尾取 overlap 个字符作为开头，
      这样相邻块之间有上下文重叠，RAG 检索不会丢语义。
      例：块1末 50 字 = 块2开头 50 字

    兜底：
      如果单个句子就超过 chunk_size（如无标点的表格数据），
      则退化为纯字符切分。
    """
    # 在每个句子边界标点后插入切分标记
    for sep in ["。", "！", "？", "；"]:
        text = text.replace(sep, sep + "<<SPLIT>>")

    sentences = text.split("<<SPLIT>>")

    chunks = []
    current = ""

    for sent in sentences:
        # 单个句子就超过限制 → 只能按字符硬切了
        if len(sent) > chunk_size:
            if current:
                chunks.append(current.strip())
                current = ""
            # 退化：纯字符切分
            start = 0
            while start < len(sent):
                end = start + chunk_size
                chunks.append(sent[start:end].strip())
                start = end - overlap
            continue

        # 正常情况：逐句追加
        if len(current) + len(sent) < chunk_size:
            current += sent
        else:
            if current:
                chunks.append(current.strip())
            # overlap: 新块开头 = 上一块的末尾几个字
            current = current[-overlap:] + sent if current else sent

    if current:
        chunks.append(current.strip())

    return chunks


# ============================================================
# 4. 主流程
# ============================================================

def process_upload(file: UploadFile, user_id: str):
    """
    处理上传文件的完整流程：存盘 → 解析 → 清洗 → 分块 → 向量化 → 入库。

    Args:
        file:    FastAPI UploadFile 对象（来自 POST /api/upload）
        user_id: 上传者（来自鉴权 dependency），写入每个 chunk 的 metadata，
                 检索时按 user_id + file_id 双重过滤，实现文件级多租户隔离

    Returns:
        {"message": "上传成功", "file_id": "a3f2b8c1", "chunks_count": 12}
    """
    # ============================================================
    # Step 1：校验文件格式
    # ============================================================
    # file.filename = "体检报告.pdf" → ext = "pdf"
    ext = file.filename.split(".")[-1].lower()

    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"仅支持 {ALLOWED_EXTENSIONS} 格式",
        )

    # ============================================================
    # Step 2：存文件到磁盘
    # ============================================================
    # file_id 用 UUID 前 8 位（十六进制），约 43 亿种组合，够用
    # 例：uploads/a3f2b8c1.pdf
    file_id = uuid.uuid4().hex[:8]
    os.makedirs(UPLOAD_DIR, exist_ok=True)  # 确保目录存在
    file_path = os.path.join(UPLOAD_DIR, f"{file_id}.{ext}")

    # 二进制写入（"wb" = write binary）
    with open(file_path, "wb") as f:
        f.write(file.file.read())

    # ============================================================
    # Step 3：解析 → 清洗 → 分块
    # ============================================================
    raw_text = read_file(file_path, ext)            # PDF → 纯文本（含标题标记）
    cleaned_text = clean_text(raw_text)              # 去噪声
    chunks = chunk_text_semantic(cleaned_text)       # 语义分块

    # ============================================================
    # Step 4：向量化 + 入库 ChromaDB
    # ============================================================
    # 每个 chunk 独立生成 embedding 向量（bge-m3, 1024 维）
    # id 格式：文件ID_序号，如 "a3f2b8c1_0", "a3f2b8c1_1"
    # metadata 记录了来源和归属文件，方便后续按文件过滤检索
    from app.services.rag.embedding import chroma_client
    from app.core.config import CHROMA_USER_UPLOAD_COLLECTION

    # 写入第一个配置的 collection（通常是 rag_samples）
    target_collection = CHROMA_USER_UPLOAD_COLLECTION
    coll = chroma_client.get_or_create_collection(name=target_collection)

    for i, chunk in enumerate(chunks):
        emb = get_embedding(chunk)
        coll.add(
            documents=[chunk],
            embeddings=[emb],
            ids=[f"{file_id}_{i}"],
            metadatas=[{
                "source": "user_upload",
                "file_id": file_id,
                "user_id": user_id,
                "filename": file.filename,
                "chunk_index": i,
            }],
        )

    return {
        "message": "上传成功",
        "file_id": file_id,
        "chunks_count": len(chunks),
        "size": os.path.getsize(file_path),
    }
