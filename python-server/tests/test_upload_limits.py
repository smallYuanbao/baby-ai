"""上传的格式与大小约束。

这三条对应的是同一个用户问题：**"上传了一个不支持的文件，界面毫无反应"**。
无反应是三层叠出来的 —— 选择器列出了后端不收的格式、后端拒绝了、而那条拒绝
没有被显示出来。这里把能测的两层钉住：能力自述接口、以及拒绝时的行为。
"""

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)
AUTH = {"Authorization": "Bearer dev-key-alice"}


def test_formats_endpoint_is_the_single_source_of_truth():
    """前端据此渲染 <input accept>，所以它必须真的反映后端能力。"""
    from app.services.upload_service import ALLOWED_EXTENSIONS

    res = client.get("/api/upload/formats")
    assert res.status_code == 200

    data = res.json()
    assert sorted(data["extensions"]) == sorted(ALLOWED_EXTENSIONS)
    assert isinstance(data["maxFileSizeMB"], int) and data["maxFileSizeMB"] > 0


def test_unsupported_extension_message_is_readable():
    """报错不能把 Python 的 set 直接格式化进去。

    原来写的是 f"仅支持 {ALLOWED_EXTENSIONS} 格式"，用户看到的是
    「仅支持 {'txt', 'pdf'} 格式」—— 带花括号和引号，像程序崩了。
    """
    # 用 .doc（老的二进制 Word 格式）当例子 —— .docx 现在已经支持了。
    res = client.post(
        "/api/upload",
        files={"file": ("简历.doc", b"whatever", "application/msword")},
        headers=AUTH,
    )
    assert res.status_code == 400

    detail = res.json()["detail"]
    assert "doc" in detail, "要指出是哪个格式不支持"
    assert "{" not in detail and "'" not in detail, f"文案里不该出现 set 字面量: {detail}"


def test_oversized_file_is_rejected_before_touching_disk(monkeypatch, tmp_path):
    """超限文件必须在**写盘之前**被拦下。

    否则一个 500MB 的文件会先落盘、再被整个读进内存解析 —— 磁盘和内存一起遭殃。
    """
    from app.services import upload_service

    # 把上限压到 0，任何非空文件都超限
    monkeypatch.setattr(upload_service, "MAX_FILE_SIZE_MB", 0)
    monkeypatch.setattr(upload_service, "UPLOAD_DIR", str(tmp_path))

    res = client.post(
        "/api/upload",
        files={"file": ("report.txt", b"hello world", "text/plain")},
        headers=AUTH,
    )

    assert res.status_code == 413
    assert "上限" in res.json()["detail"]
    assert list(tmp_path.iterdir()) == [], "被拒的文件不该留下任何磁盘产物"


def test_scanned_pdf_with_no_text_is_rejected_with_a_reason(monkeypatch, tmp_path):
    """提取不出文字的 PDF 不能"上传成功但什么都没有"。

    真实案例：一份 697KB 的房屋租赁合同 PDF（扫描件），解析出空文本。
    以前的表现是上传成功、chunks_count=0、Chroma 里一条没有 —— 文件是死的，
    而用户以为助手能读。现在必须当场说明原因。
    """
    from app.services import upload_service

    monkeypatch.setattr(upload_service, "UPLOAD_DIR", str(tmp_path))
    # 让解析结果为空，模拟扫描件（不依赖真实 PDF，测试更稳）
    monkeypatch.setattr(upload_service, "read_file", lambda path, ext: "")
    monkeypatch.setattr(upload_service, "clean_text", lambda t: "")

    res = client.post(
        "/api/upload",
        files={"file": ("合同.pdf", b"%PDF-1.4 fake", "application/pdf")},
        headers=AUTH,
    )

    assert res.status_code == 400
    detail = res.json()["detail"]
    assert "没有可提取的文字" in detail
    assert "OCR" in detail, "要说清为什么不支持，而不是只说'失败'"
    assert list(tmp_path.iterdir()) == [], "被拒的文件不该留在磁盘上"
