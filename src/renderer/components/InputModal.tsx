// src/renderer/components/InputModal.tsx
//
// 渲染层内自建输入模态框（§3.3 Electron 陷阱注记）：替代被禁用的 window.prompt。
// 默认聚焦、Enter 确认、Esc 取消，不依赖任何 Electron 专有 API（符合第 8 节可移植性）。
import { useState } from 'react';
import { styles } from '../styles';

interface Props {
  title: string;
  initialValue?: string;
  confirmLabel?: string;
  placeholder?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

export function InputModal({ title, initialValue = '', confirmLabel = '确定', placeholder, onConfirm, onCancel }: Props) {
  const [value, setValue] = useState(initialValue);
  return (
    <>
      <div style={styles.modalBackdrop} onClick={onCancel} />
      <div style={styles.modalBox}>
        <div style={styles.modalTitle}>{title}</div>
        <input
          autoFocus
          style={styles.modalInput}
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onConfirm(value.trim());
            else if (e.key === 'Escape') onCancel();
          }}
        />
        <div style={styles.modalActions}>
          <button style={styles.modalBtn} onClick={onCancel}>
            取消
          </button>
          <button style={styles.modalBtnPrimary} onClick={() => onConfirm(value.trim())}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </>
  );
}
