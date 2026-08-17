import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
import sys

# 创建日志目录
LOG_DIR = Path("logs")
LOG_DIR.mkdir(exist_ok=True)

def setup_logger(name: str = "baby-ai") -> logging.Logger:
    """创建并配置全局 logger"""
    logger = logging.getLogger(name)

     # 避免重复添加 handler
    if logger.handlers:
        return logger

    logger.setLevel(logging.DEBUG)

    # 统一格式：时间 | 级别 | 模块 | 消息
    formatter = logging.Formatter(
        fmt="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S"
    )

    # 控制台输出（开发时看）
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(logging.DEBUG) 
    console_handler.setFormatter(formatter)
    logger.addHandler(console_handler)

    # 文件输出（持久化，10MB 轮转，保留 3 个备份）
    file_handler = RotatingFileHandler(
        LOG_DIR / "app.log",
        maxBytes=10 * 1024 * 1024,
        backupCount=3,
        encoding="utf-8"
    )

    file_handler.setLevel(logging.INFO)
    file_handler.setFormatter(formatter)
    logger.addHandler(file_handler)

    return logger

# 全局实例，其他模块直接 from app.utils.logger import logger

logger = setup_logger()

    