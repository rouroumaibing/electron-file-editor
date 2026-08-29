// src/renderer/components/ConfirmModal.tsx
//
// 渲染层内自建确认模态框（§3.3 Electron 陷阱注记）：替代被禁用的 window.confirm。
import { styles } from '../styles';

interface Props {
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({ title, message, confirmLabel = '确定', onConfirm, onCancel }: Props) {
  return (
    <>
      <div style={styles.modalBackdrop} onClick={onCancel} />
      <div style={styles.modalBox}>
        <div style={styles.modalTitle}>{title}</div>
        <div style={styles.modalMsg}>{message}</div>
        <div style={styles.modalActions}>
          <button style={styles.modalBtn} onClick={onCancel}>
            取消
          </button>
          <button style={styles.modalBtnPrimary} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </>
  );
}
