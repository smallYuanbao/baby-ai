/**
 * ChildSelector 组件
 *
 * 成长记录模块的入口视图：展示已有宝宝列表，并提供「添加宝宝」。
 *
 * - 点击卡片进入该宝宝的成长记录
 * - 删除宝宝（antd Popconfirm 二次确认）
 * - 通过 antd Modal + Form 创建新宝宝
 *
 * @module ChildSelector
 */

import { useState, useEffect } from 'react';
import {
  Button, DatePicker, Form, Input, Modal, Popconfirm, Radio,
} from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useGrowth } from '../../contexts/GrowthContext';
import { LoadingState } from '../shared/LoadingState';
import styles from './ChildSelector.module.less';

/** 「添加宝宝」表单的字段值。 */
interface CreateChildValues {
  name: string;
  birthDate: Dayjs;
  gender: 'male' | 'female';
}

/**
 * 宝宝选择器组件。
 *
 * 首次挂载时自动加载宝宝列表，加载中显示 LoadingState。
 *
 * **不需要 props**：选中哪个宝宝由 `GrowthProvider` 里的共享状态决定，
 * 点卡片时直接 `loadChild()` 写进那份状态（见 contexts/GrowthContext.tsx）。
 */
export function ChildSelector() {
  const { children, loading, loadChildren, createChild, deleteChild, loadChild } = useGrowth();
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  /**
   * 正在打开哪个宝宝（点卡片后要请求 getChild 拿完整档案）。
   *
   * 以前这一步**完全没有加载提示** —— 请求期间界面纹丝不动，
   * 网络慢的时候用户会以为点了没反应，然后再点一次。
   */
  const [selectingId, setSelectingId] = useState<string | null>(null);
  const [form] = Form.useForm<CreateChildValues>();

  // 组件挂载时自动拉取宝宝列表
  useEffect(() => {
    loadChildren();
  }, [loadChildren]);

  /** 关闭「添加宝宝」弹窗，并把表单清空（下次打开是干净的）。 */
  const closeForm = () => {
    setShowForm(false);
    form.resetFields();
  };

  /**
   * 提交创建新宝宝。
   *
   * 姓名/出生日期的非空校验交给 `Form.Item` 的 rules，这里只做数据整形。
   * 错误由 useGrowth hook 内部统一处理。
   */
  const handleCreate = async (values: CreateChildValues) => {
    setSubmitting(true);
    try {
      const child = await createChild({
        name: values.name.trim(),
        birthDate: values.birthDate.format('YYYY-MM-DD'),
        gender: values.gender,
      });
      if (child) {
        // 新建完直接进这个宝宝的详情页。走 loadChild 而不是拿 createChild 的返回值凑合：
        // 写入 selectedChild 只保留这一条路径，免得「有些入口带 records、有些不带」。
        await loadChild(child.childId);
        closeForm();
      }
    } catch {
      /* hook 已处理错误 */
    }
    setSubmitting(false);
  };

  /** 选中某个宝宝：拉取完整档案写进共享状态（列表 / 图表 / 分析一起更新）。 */
  const handleSelect = async (childId: string) => {
    setSelectingId(childId);
    // 走 hook 的 loadChild,而不是在这里自己调 api.growth.getChild ——
    // 后者是同一个请求的第二份实现,两处各写一遍,改了一处忘了另一处是迟早的事。
    // loadChild 会把完整档案写进共享状态,所有消费者一起更新。
    await loadChild(childId);
    setSelectingId(null);
  };

  // 初始加载中且尚无缓存数据时，展示加载态
  if (loading && children.length === 0) {
    return <LoadingState text="正在加载宝宝档案…" />;
  }

  // 点击宝宝后、档案还没回来之前：也给个反馈，别让界面纹丝不动
  if (selectingId) {
    return <LoadingState text="正在打开宝宝档案…" />;
  }

  return (
    <div className={styles.wrapper}>
      <div className={styles.header}>
        <span className={styles.headerIcon}>📈</span>
        <h2 className={styles.title}>成长记录</h2>
        <p className={styles.subtitle}>记录宝宝每一步成长</p>
      </div>

      {/* 宝宝列表 */}
      {children.length > 0 && (
        <div className={styles.list}>
          {children.map((child) => (
            /*
              卡片用 div + role="button"，**不能用 <button>**。
              原来外层是 <button>、删除按钮也是个 <button>，形成「按钮套按钮」——
              这是无效 HTML（交互内容不能嵌套），React 会报
              `validateDOMNesting: <button> cannot appear as a descendant of <button>`，
              而且读屏软件没法正确表达「卡片里还有个删除按钮」。
              同理，Popconfirm 挂在嵌套的 button 上行为也不可靠。
            */
            <div
              key={child.childId}
              role="button"
              tabIndex={0}
              onClick={() => handleSelect(child.childId)}
              // role="button" 需要自己补键盘行为，否则键盘用户按不动
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  handleSelect(child.childId);
                }
              }}
              className={styles.childCard}
            >
              <div className={styles.childCardInner}>
                <div className={styles.childInfo}>
                  <span className={styles.childAvatar}>
                    {child.gender === 'male' ? '👦' : '👧'}
                  </span>
                  <div>
                    <h3 className={styles.childName}>{child.name}</h3>
                    <p className={styles.childMeta}>
                      🎂 {child.birthDate} · {child.recordCount} 条记录
                    </p>
                  </div>
                </div>

                {/* 包一层 span 截断冒泡：点删除不应该顺带把宝宝选中 */}
                <span onClick={(e) => e.stopPropagation()} className={styles.deleteWrap}>
                  <Popconfirm
                    title={`删除 ${child.name}？`}
                    description="该宝宝的所有成长记录会一并删除，且无法恢复。"
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => deleteChild(child.childId)}
                  >
                    <button
                      className={styles.deleteButton}
                      title="删除"
                      aria-label={`删除 ${child.name}`}
                    >
                      🗑
                    </button>
                  </Popconfirm>
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 添加宝宝：触发按钮 + antd Modal 表单 */}
      <Button type="dashed" block size="large" onClick={() => setShowForm(true)}>
        + 添加宝宝
      </Button>

      <Modal
        open={showForm}
        title="添加宝宝"
        onCancel={closeForm}
        footer={null}
        width={420}
        // antd 6 的 Modal **没有 `top` 这个 prop**（v5 有、v6 移除了），
        // 但 `.ant-modal` 上仍带着 `top: 100px`。用 style 覆盖成更小的值：
        // 日期面板高 361px，加上弹窗内它上方的 182px 内容，100px 的偏移需要
        // 643px 视口才放得下 —— 矮窗口下面板会被顶出屏幕。48px 后 600px 也够。
        style={{ top: 48 }}
        // 刻意**不加 `centered`**：弹窗居中后上下各只剩一百多像素，而 antd 的日期面板
        // 有 410px 高，两边都放不下 —— 实测视口高 760px 时面板会向上弹到屏幕外
        // （面板 top = -53px，被浏览器顶栏遮住）。靠上摆放（antd 默认 top: 100px）
        // 能给下方腾出足够空间，面板正常向下展开。
        maskClosable={false}
      >
        <Form<CreateChildValues>
          form={form}
          layout="vertical"
          initialValues={{ gender: 'male' }}
          onFinish={handleCreate}
        >
          <Form.Item
            name="name"
            label="宝宝名字"
            rules={[{ required: true, message: '请输入宝宝名字' }]}
          >
            <Input placeholder="如：小豆豆" maxLength={20} />
          </Form.Item>

          <Form.Item
            name="birthDate"
            label="出生日期"
            rules={[{ required: true, message: '请选择出生日期' }]}
          >
            <DatePicker
              style={{ width: '100%' }}
              format="YYYY-MM-DD"
              placeholder="选择出生日期"
              // 「今天」这个快捷入口对出生日期没意义（宝宝不可能今天出生），
              // 去掉它顺带让面板矮 44px，缓解上面那个高度问题
              showToday={false}
              // 出生日期不可能在未来
              disabledDate={(d) => !!d && d.isAfter(dayjs(), 'day')}
            />
          </Form.Item>

          <Form.Item name="gender" label="性别">
            <Radio.Group>
              <Radio.Button value="male">👦 男孩</Radio.Button>
              <Radio.Button value="female">👧 女孩</Radio.Button>
            </Radio.Group>
          </Form.Item>

          <div className={styles.modalActions}>
            <Button onClick={closeForm} disabled={submitting}>
              取消
            </Button>
            <Button type="primary" htmlType="submit" loading={submitting}>
              确认创建
            </Button>
          </div>
        </Form>
      </Modal>
    </div>
  );
}
