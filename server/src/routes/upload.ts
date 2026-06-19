import { Router } from 'express';
import { upload } from '../middleware/upload.js';
import { fileParser } from '../services/fileParser.js';
import type { UploadedFile } from '../types/upload.js';
import logger from '../utils/logger.js';

/**
 * 上传路由（Upload Routes）
 *
 * 定义与文件上传相关的 API 端点。
 *
 * ## 端点列表
 *
 * | 方法 | 路径         | 说明                     |
 * |------|-------------|--------------------------|
 * | POST | /api/upload | 上传单个文件并提取文本内容 |
 *
 * ## 中间件链
 *
 * - `upload.single('file')`：基于 multer 的多部分文件上传中间件，负责
 *   接收 `multipart/form-data` 请求中的 `file` 字段，将文件写入磁盘，
 *   并校验文件类型与大小限制。
 *
 * ## 错误场景
 *
 * - **400 Bad Request** — 请求中未包含 `file` 字段，或文件字段为空
 *   （响应体 `{ error, code: 'NO_FILE' }`）。
 * - **multer 错误** — 文件类型不在白名单中会抛出 `Error`，由 multer 拦截
 *   并传递给 Express 全局错误处理中间件。
 * - **文件过大** — 超过 `config.upload.maxFileSizeMB` 限制时，
 *   multer 抛出 `MulterError`，同样流向全局错误处理。
 * - **文本提取失败** — 提取过程抛出异常时仅记录警告日志（`logger.warn`），
 *   不会中断请求；`extractedText` 字段为 `undefined`。
 * - **500 Internal Server Error** — 其他未预期的运行时异常通过 `next(err)`
 *   传递给全局错误处理中间件。
 */
export const uploadRouter = Router();

/**
 * POST /api/upload — 上传文件
 *
 * 接收客户端上传的单个文件，将其保存到服务端磁盘，并尝试从文件中提取
 * 可读文本内容（适用于 txt、pdf 等格式）。返回文件元信息与提取结果。
 *
 * @param req  - Express 请求对象。在 multer 中间件执行后，
 *               `req.file` 上挂载了 `Express.Multer.File` 实例，
 *               包含 `filename`、`originalname`、`mimetype`、
 *               `size`、`path` 等属性。
 * @param res  - Express 响应对象。成功时以 200 状态码返回
 *               {@link UploadedFile} JSON 对象；请求无效时返回
 *               400 及 `{ error, code: 'NO_FILE' }`。
 * @param next - Express 下一个中间件函数。用于将未被捕获的异常
 *               传递给全局错误处理中间件。
 *
 * @returns 通过 `res.json()` 返回 {@link UploadedFile} 对象：
 *          - `fileId`       — multer 生成的文件名（UUID + 原扩展名）
 *          - `originalName` — 客户端提交的原始文件名
 *          - `mimeType`     — 文件的 MIME 类型
 *          - `size`         — 文件大小（字节）
 *          - `path`         — 服务端磁盘上的文件全路径
 *          - `extractedText` — 提取出的文本内容；提取失败则为 `undefined`
 */
uploadRouter.post('/', upload.single('file'), async (req, res, next) => {
  try {
    // 校验：multer 未能解析到文件（请求未携带 file 字段，或字段为空）
    if (!req.file) {
      res.status(400).json({ error: '请选择文件', code: 'NO_FILE' });
      return;
    }

    // 从上传文件中提取文本内容
    let extractedText: string | undefined;
    try {
      // fileParser.extract 根据 MIME 类型分发到不同的提取策略：
      // - text/plain → 直接读取文件内容（截取前 5000 字符）
      // - application/pdf → 使用 pdf-parse 库解析 PDF 文本（截取前 5000 字符）
      // - 图片/Word 等 → 返回占位提示字符串
      extractedText = await fileParser.extract(req.file.path, req.file.mimetype);
    } catch (err) {
      // 文本提取为非关键路径：提取失败仅记录警告，不中断请求流程
      // 避免因解析库异常导致整个上传接口不可用
      logger.warn('文件文本提取失败，将仅保留文件信息:', err);
    }

    // 组装响应体，字段与 UploadedFile 接口保持一致
    const uploadedFile: UploadedFile = {
      fileId: req.file.filename,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      path: req.file.path,
      extractedText,
    };

    // 返回 200 OK，无需额外的数据包装层
    res.json(uploadedFile);
  } catch (err) {
    // 未预期的运行时异常交由 Express 全局错误处理中间件处理，
    // 通常返回 500 错误
    next(err);
  }
});
