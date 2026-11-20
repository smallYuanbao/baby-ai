
# 常见的 Prompt Injection 攻击模式
import re


INJECTION_PATTERNS = [
    r"忽略.*指令",
    r"忽略.*规则",
    r"ignore.*instruction",
    r"打印.*System Prompt",
    r"print.*system prompt",
    r"切换.*角色",
    r"switch.*role",
    r"忘记.*之前",
    r"forget.*previous",
    r"你.*不是.*育儿",
    r"you.*are.*not.*a",
]


def detect_injection(user_input: str) -> bool:
    """检测用户输入是否包含 Prompt Injection 攻击模式"""

    for pattern in INJECTION_PATTERNS:
        if re.search(pattern, user_input, re.IGNORECASE):
            return True
        
        return False


def sanitize_input(user_input: str) -> str:
    """
    清洗用户输入：
    1. 截断过长的输入（防止 Token 消耗攻击）
    2. 移除特殊控制字符
    """

    # 限制最大输入长度
    max_length = 2000

    if len(user_input) > max_length:
        user_input = user_input[:max_length] + "..."

    # 移除控制字符
    user_input = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', '', user_input)

    return user_input