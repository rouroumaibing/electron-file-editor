// src/renderer/components/SettingsModal.tsx
//
// 设置面板（§14 替代崩溃恢复的方案③：自动定时保存）。仅在渲染层经 localStorage
// 持久化客户端偏好（自动保存开关 + 间隔），不进主进程。模态框替代原生 dialog（§3.3）。

import { useState } from 'react';
import { createStyles, LIGHT_THEME } from '../styles';
import type { ThemeTokens } from '../theme';
import type { AutoSaveSettings } from '../settings';

interface Props {
  settings: AutoSaveSettings;
  onSave: (next: AutoSaveSettings) => void;
  onClose: () => void;
  theme?: ThemeTokens;
}

export function SettingsModal({ settings, onSave, onClose, theme }: Props) {
  const [enabled, setEnabled] = useState(settings.autoSaveEnabled);
  const [intervalSec, setIntervalSec] = useState(Math.round(settings.autoSaveIntervalMs / 1000));
  const s = createStyles(theme ?? LIGHT_THEME);

  const apply = () => {
    const sec = Math.max(1, Math.floor(intervalSec) || 1);
    onSave({ autoSaveEnabled: enabled, autoSaveIntervalMs: sec * 1000 });
    onClose();
  };

  return (
    <div style={s.modalBackdrop} onClick={onClose}>
      <div style={s.modalBox} onClick={(e) => e.stopPropagation()}>
        <div style={s.modalTitle}>设置</div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: String(s.textPrimary) }}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          启用自动定时保存
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: String(s.textPrimary) }}>
          保存间隔（秒）：
          <input
            type="number"
            min={1}
            value={intervalSec}
            onChange={(e) => setIntervalSec(Number(e.target.value))}
            style={s.modalInput}
          />
        </label>
        <div style={{ ...s.modalMsg, fontSize: 12 }}>
          开启后，未保存的改动会按间隔自动写回原文件（关闭客户端不再提示这些文件）。
        </div>
        <div style={s.modalActions}>
          <button style={s.modalBtn} onClick={onClose}>
            取消
          </button>
          <button style={s.modalBtnPrimary} onClick={apply}>
            确定
          </button>
        </div>
      </div>
    </div>
  );
}
