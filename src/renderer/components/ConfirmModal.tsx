// src/renderer/components/ConfirmModal.tsx
//
// 渲染层内自建确认模态框（§3.3 Electron 陷阱注记）：替代被禁用的 window.confirm。
import { createStyles, LIGHT_THEME } from '../styles';
import type { ThemeTokens } from '../theme';

interface Props {
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  theme?: ThemeTokens;
}

export function ConfirmModal({ title, message, confirmLabel = '确定', onConfirm, onCancel, theme }: Props) {
  const s = createStyles(theme ?? LIGHT_THEME);
  return (
    <>
      <div style={s.modalBackdrop} onClick={onCancel} />
      <div style={s.modalBox}>
        <div style={s.modalTitle}>{title}</div>
        <div style={s.modalMsg}>{message}</div>
        <div style={s.modalActions}>
          <button style={s.modalBtn} onClick={onCancel}>
            取消
          </button>
          <button style={s.modalBtnPrimary} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </>
  );
}
