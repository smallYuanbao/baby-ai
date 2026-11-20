import numpy as np

def softmax(x):
    """Softmax 函数：把任意向量转成概率分布（所有值加起来=1）"""
    exp_x = np.exp(x - np.max(x))  # 减最大值防止溢出
    return exp_x / exp_x.sum(axis=-1, keepdims=True)

def self_attention(X, d_k=4):
    """
    极简 Self-Attention 实现

    参数：
        X: 输入矩阵，形状 (seq_len, d_model)，每行是一个词的向量
        d_k: Q/K 的维度

    返回：
        output: 注意力加权后的新表示，形状 (seq_len, d_model)
        attention_weights: 注意力权重矩阵，形状 (seq_len, seq_len)
    """
    seq_len, d_model = X.shape

    # 1. 随机初始化 Q/K/V 的权重矩阵（实际训练中这些是通过学习得到的）
    W_Q = np.random.randn(d_model, d_k) * 0.1
    W_K = np.random.randn(d_model, d_k) * 0.1
    W_V = np.random.randn(d_model, d_k) * 0.1

    print("Q 权重矩阵形状:", W_Q.shape)  # (d_model, d_k)
    print("W_Q 矩阵内容:\n", W_Q)
    print("K 权重矩阵形状:", W_K.shape)  # (d_model, d_k)
    print("W_K 矩阵内容:\n", W_K)
    print("V 权重矩阵形状:", W_V.shape)
    print("W_V 矩阵内容:\n", W_V)

    # 2. 计算 Q、K、V
    Q = X @ W_Q  # (seq_len, d_k)
    K = X @ W_K  # (seq_len, d_k)
    V = X @ W_V  # (seq_len, d_k)

    print("Q 矩阵形状:", Q.shape)  # (seq_len, d_k)
    print("Q 矩阵内容:\n", Q)
    print("K 矩阵形状:", K.shape)  # (seq_len, d_k)
    print("K 矩阵内容:\n", K)
    print("V 矩阵形状:", V.shape)  # (seq_len, d_k)
    print("V 矩阵内容:\n", V)

    # 3. 计算注意力分数：Q 和 K 的点积，除以 sqrt(d_k) 做缩放
    scores = Q @ K.T / np.sqrt(d_k)  # (seq_len, seq_len)

    # 4. Softmax 转为概率
    attention_weights = softmax(scores)  # (seq_len, seq_len)

    # 5. 用概率对 V 加权求和
    output = attention_weights @ V  # (seq_len, d_k)

    return output, attention_weights

# ==================== 运行示例 ====================

if __name__ == "__main__":
    # 模拟一个句子：4 个词，每个词用 6 维向量表示
    # 假设句子是 "宝宝 发烧 怎么 办"
    X = np.array([
        [0.8, 0.3, 0.1, 0.5, 0.2, 0.7],  # 宝宝
        [0.2, 0.9, 0.4, 0.3, 0.6, 0.1],  # 发烧
        [0.5, 0.1, 0.8, 0.2, 0.3, 0.4],  # 怎么
        [0.1, 0.4, 0.2, 0.9, 0.5, 0.3],  # 办
    ])

    output, attn = self_attention(X)

    print("输入形状:", X.shape)          # (4, 6)
    print("输出形状:", output.shape)     # (4, 4)
    print("\n注意力权重矩阵 (4x4):")
    print("      宝宝    发烧    怎么    办")
    for i, word in enumerate(["宝宝", "发烧", "怎么", "办"]):
        print(f"{word}  {attn[i]}")

    print("\n解读：每一行表示这个词对句子中所有词的注意力分布")
    print("例如 '宝宝' 行中值最大的列，表示 '宝宝' 最关注哪个词")