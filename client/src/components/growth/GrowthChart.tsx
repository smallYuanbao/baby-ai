/**
 * GrowthChart — 生长曲线图表组件
 *
 * 展示指定儿童在体重、身高、头围三个维度的生长曲线。
 * 通过指标切换按钮选择维度，使用 Recharts 渲染折线图，
 * 横轴为月龄，纵轴为对应单位的测量值。
 *
 * @module GrowthChart
 */

import { useState, useEffect } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { useGrowth } from '../../hooks/useGrowth';
import type { ChartDataResponse } from '../../types/growth';
import styles from './GrowthChart.module.less';

/** GrowthChart 组件的 props */
interface GrowthChartProps {
  /** 儿童唯一标识 */
  childId: string;
  /** 儿童姓名，用于图表标题展示 */
  childName: string;
}

/** 测量指标键名 */
type MetricKey = 'weight' | 'height' | 'headCircumference';

/**
 * 可切换的测量指标定义列表
 *
 * 每个指标包含键名、中文标签、单位及图表线条颜色。
 * 颜色与 Tailwind CSS 调色板对齐：orange-500, blue-500, violet-500。
 */
const METRICS: { key: MetricKey; label: string; unit: string; color: string }[] = [
  { key: 'weight', label: '体重', unit: 'kg', color: '#f97316' },
  { key: 'height', label: '身高', unit: 'cm', color: '#3b82f6' },
  { key: 'headCircumference', label: '头围', unit: 'cm', color: '#8b5cf6' },
];

/**
 * GrowthChart 组件
 *
 * - 顶部提供指标切换按钮（体重 / 身高 / 头围）。
 * - 加载中显示 "加载中..." 占位。
 * - 无数据时展示空状态提示。
 * - 有数据时渲染 Recharts 折线图，含网格、坐标轴标签、Tooltip。
 *
 * @param props - 包含 childId 与 childName
 */
export function GrowthChart({ childId, childName }: GrowthChartProps) {
  const { getChartData } = useGrowth();
  const [metric, setMetric] = useState<MetricKey>('weight');
  const [data, setData] = useState<ChartDataResponse | null>(null);
  const [loading, setLoading] = useState(false);

  // 当 childId 或 metric 变化时重新获取图表数据
  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      try {
        const result = await getChartData(childId, metric);
        setData(result);
      } catch { /* 静默处理请求错误，保持 loading 状态结束 */ }
      setLoading(false);
    };
    fetchData();
  }, [childId, metric, getChartData]);

  // 查找当前选中指标的完整定义，保证非空（METRICS 列表固定包含该 key）
  const currentMetric = METRICS.find((m) => m.key === metric)!;

  return (
    <div className={styles.wrapper}>
      {/* 指标切换按钮组 */}
      <div className={styles.metricToggle}>
        {METRICS.map((m) => (
          <button
            key={m.key}
            onClick={() => setMetric(m.key)}
            className={`${styles.metricTab} ${metric === m.key ? styles.active : styles.inactive}`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* 图表区域：按加载态 / 空数据 / 正常数据分支渲染 */}
      {loading ? (
        <div className={styles.loadingState}>加载中...</div>
      ) : !data || data.dataPoints.length === 0 ? (
        <div className={styles.emptyState}>
          <span className={styles.emptyIcon}>📊</span>
          <p>暂无{currentMetric.label}数据</p>
          <p className={styles.emptyHint}>添加记录后自动生成曲线</p>
        </div>
      ) : (
        <div>
          {/* 图表标题栏：儿童姓名 + 指标名 + 数据点计数 */}
          <div className={styles.chartHeader}>
            <h4 className={styles.chartTitle}>
              {childName} · {currentMetric.label}曲线
            </h4>
            <span className={styles.chartDataPoints}>{data.dataPoints.length} 个数据点</span>
          </div>

          {/* Recharts 折线图容器 */}
          <div className={styles.chartContainer}>
            <ResponsiveContainer width="100%" height={250}>
              <LineChart data={data.dataPoints} margin={{ top: 10, right: 10, left: 0, bottom: 10 }}>
                {/* 浅橙色虚线网格 */}
                <CartesianGrid strokeDasharray="3 3" stroke="#fef0e0" />

                {/* X 轴：月龄 */}
                <XAxis
                  dataKey="ageMonths"
                  label={{ value: '月龄', position: 'insideBottom', offset: -5, fontSize: 11 }}
                  tick={{ fontSize: 11 }}
                  stroke="#d1d5db"
                />

                {/* Y 轴：当前指标单位 */}
                <YAxis
                  label={{ value: currentMetric.unit, angle: -90, position: 'insideLeft', fontSize: 11 }}
                  tick={{ fontSize: 11 }}
                  stroke="#d1d5db"
                />

                {/* 悬浮提示：展示数值 + 单位，X 轴标签附带 "个月" */}
                <Tooltip
                  contentStyle={{ borderRadius: '12px', border: '1px solid #fed7aa', fontSize: '12px' }}
                  formatter={(value: any) => [`${value} ${currentMetric.unit}`, currentMetric.label]}
                  labelFormatter={(label: any) => `${label} 个月`}
                />

                {/* 折线：平滑曲线，实心圆点，hover 放大 */}
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke={currentMetric.color}
                  strokeWidth={2.5}
                  dot={{ r: 4, fill: currentMetric.color, stroke: 'white', strokeWidth: 2 }}
                  activeDot={{ r: 6 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}
