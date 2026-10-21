"""各格式的文本提取。

重点在 `.docx` 的**表格**：体检报告 / 化验单 / 疫苗记录大量是表格，简易地剥标签
会把表格压成一整行，读出来是一坨 —— 检索和模型都用不了。这里钉住"按行保留"。
"""

import zipfile

from app.services.upload_service import read_file

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def _make_docx(path, body_xml: str) -> str:
    """造一个最小可解析的 .docx（本质是 zip，正文在 word/document.xml）。"""
    doc = (
        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<w:document xmlns:w="{W}"><w:body>{body_xml}</w:body></w:document>'
    )
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("word/document.xml", doc)
    return str(path)


def test_md_is_read_as_plain_text(tmp_path):
    f = tmp_path / "note.md"
    f.write_text("# 喂养要点\n\n6 个月后添加辅食。", encoding="utf-8")
    text = read_file(str(f), "md")
    assert "喂养要点" in text and "辅食" in text


def test_csv_handles_gbk_encoding(tmp_path):
    """中文 Windows 上 Excel 导出的 CSV 常见是 GBK —— 按 UTF-8 读会直接报错。"""
    f = tmp_path / "data.csv"
    f.write_bytes("月龄,身高,体重\n5个月,70cm,8.5kg\n".encode("gbk"))
    text = read_file(str(f), "csv")
    assert "月龄" in text and "8.5kg" in text


def test_csv_handles_utf8_bom(tmp_path):
    """Excel 还爱加 BOM；utf-8-sig 保证正文开头不留不可见字符。"""
    f = tmp_path / "bom.csv"
    f.write_bytes("月龄,身高\n5个月,70cm\n".encode("utf-8-sig"))
    text = read_file(str(f), "csv")
    assert text.startswith("月龄"), f"开头有残留字符: {text[:5]!r}"


def test_docx_keeps_paragraphs(tmp_path):
    body = (
        "<w:p><w:r><w:t>宝宝体检报告</w:t></w:r></w:p>"
        # 一句话被拆成多个 run，必须拼回同一段
        "<w:p><w:r><w:t>姓名：</w:t></w:r><w:r><w:t>小元宝</w:t></w:r></w:p>"
    )
    path = _make_docx(tmp_path / "a.docx", body)
    text = read_file(path, "docx")

    assert "宝宝体检报告" in text
    assert "姓名：小元宝" in text, "被拆成多个 run 的一句话必须拼回来"


def test_docx_table_keeps_rows_and_columns(tmp_path):
    """表格必须按行保留 —— 这是这一版的重点。

    反例：简单剥标签得到的是「项目数值身高70cm体重8.5kg」，
    一行糊在一起，模型根本读不出哪一项对应哪个值。
    """
    body = (
        "<w:tbl>"
        "<w:tr><w:tc><w:p><w:r><w:t>项目</w:t></w:r></w:p></w:tc>"
        "<w:tc><w:p><w:r><w:t>数值</w:t></w:r></w:p></w:tc></w:tr>"
        "<w:tr><w:tc><w:p><w:r><w:t>身高</w:t></w:r></w:p></w:tc>"
        "<w:tc><w:p><w:r><w:t>70cm</w:t></w:r></w:p></w:tc></w:tr>"
        "</w:tbl>"
    )
    path = _make_docx(tmp_path / "t.docx", body)
    text = read_file(path, "docx")

    assert "项目 | 数值" in text
    assert "身高 | 70cm" in text
    # 每一行独立，不能糊成一行
    assert text.count("\n") >= 1


def test_docx_handles_document_without_body(tmp_path):
    """结构异常的 docx 不能抛未捕获异常 —— 走 read_file 的 500 分支。"""
    with zipfile.ZipFile(tmp_path / "bad.docx", "w") as zf:
        zf.writestr("word/document.xml", "<root/>")
    assert read_file(str(tmp_path / "bad.docx"), "docx") == ""
