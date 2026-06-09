export type DestructiveConfirmState = {
  open: boolean;
  loading: boolean;
  reasonRequired: boolean;
  reason: string;
  requiresPin: boolean;
  pin: string;
  pinLength: number;
};

export const createInitialState = (): DestructiveConfirmState => ({
  open: false,
  loading: false,
  reasonRequired: false,
  reason: '',
  requiresPin: false,
  pin: '',
  pinLength: 4,
});

export function canConfirmDestructiveAction(state: DestructiveConfirmState): boolean {
  if (!state.open) return false;
  if (state.loading) return false;

  if (state.reasonRequired && state.reason.trim() === '') {
    return false;
  }

  if (state.requiresPin && state.pin.length < state.pinLength) {
    return false;
  }

  return true;
}

export function getResetStateOnClose(state: DestructiveConfirmState): DestructiveConfirmState {
  return {
    ...state,
    open: false,
    reason: '',
    pin: '',
    loading: false,
  };
}

export function isPinInputVisible(state: DestructiveConfirmState): boolean {
  return state.open && state.requiresPin;
}

export function isModalVisible(state: DestructiveConfirmState): boolean {
  return state.open;
}

export interface PreventableEvent {
  key: string;
  preventDefault: () => void;
  stopPropagation: () => void;
}

export function handlePreventEnter(e: PreventableEvent): void {
  if (e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();
  }
}
