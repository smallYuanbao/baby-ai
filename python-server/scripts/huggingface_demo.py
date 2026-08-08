import torch  # transformers 的 pipeline 内部用 torch 但未显式导入，必须手动
from transformers import AutoModelForCausalLM, AutoTokenizer
from transformers.pipelines import pipeline


print("=" * 50)
print("HuggingFace 推理 Demo")
print("=" * 50)

# 方案 A：用 Pipelines（最简单，一行搞定）
print("\n[方案A] 使用 Pipelines 做文本生成...")
generator = pipeline(
    "text-generation",
    model="distilgpt2",  # safetensors格式，Intel Mac唯一能跑的模型
    max_length=50,
)
result = generator("宝宝发烧了")
print(f"生成结果: {result[0]['generated_text']}")


# 方案 B：手动加载模型和分词器（更灵活，和你的项目最接近）
print("\n[方案B] 手动加载模型和分词器...")
model_name = "distilgpt2"  # safetensors格式，Intel Mac唯一能跑的模型
# 分词器
tokenizer = AutoTokenizer.from_pretrained(model_name)
# 初始化大模型
model = AutoModelForCausalLM.from_pretrained(model_name)

# 手动完成 encode → 推理 → decode 的全流程
inputs = tokenizer("宝宝发烧怎么办", return_tensors="pt")
# 调用大模型
outputs = model.generate(**inputs, max_length=50)
# 输出大模型的实际内容
result_text = tokenizer.decode(outputs[0], skip_special_tokens=True)
print(f"生成结果: {result_text}")