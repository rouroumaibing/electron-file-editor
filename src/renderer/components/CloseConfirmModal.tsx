// src/renderer/components/CloseConfirmModal.tsx
//
// 关闭客户端提示（§14 替代崩溃恢复的方案①）：存在未保存文件时，用户点关闭
// 弹此三选框。渲染层模态框替代被禁用的原生 dialog（见 §3.3 Electron 陷阱）。
//   - 保存：写回所有 dirty 文件后放行关闭
//   - 不保存：直接放行关闭（丢弃未保存内容，符合"关闭即不管恢复"的产品决策）
//   - 取消：中止关闭，窗口保持打开

import { styles } from '../styles';

interface Props {
  dirtyCount: number;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

export function CloseConfirmModal({ dirtyCount, onSave, onDiscard, onCancel }: Props) {
  return (
    <div style={styles.modalBackdrop} onClick={onCancel}>
      <div style={styles.modalBox} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalTitle}>有未保存的更改</div>
        <div style={styles.modalMsg}>
          当前有 {dirtyCount} 个文件未保存。关闭后将无法恢复这些更改。
        </div>
        <div style={styles.modalActions}>
          <button style={styles.modalBtn} onClick={onCancel}>
            取消
          </button>
          <button style={styles.modalBtn} onClick={onDiscard}>
            不保存
          </button>
          <button style={styles.modalBtnPrimary} onClick={onSave}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
