from app.skills.weather import WeatherSkill

# 注册表：新增 Skill 在这里加一行
REGISTERED_SKILLS = [WeatherSkill]


def get_skill_by_name(name: str):
    for cls in REGISTERED_SKILLS:
        if cls.name == name:
            return cls()
    return None
