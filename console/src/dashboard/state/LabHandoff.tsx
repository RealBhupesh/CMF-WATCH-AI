import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import type { Intent, Reply, Tone } from '../lib/api';

export interface LabHandoff {
  replies: Reply[];
  sender: string;
  app: string;
  tone: Tone;
  from_ai: boolean;
  selectedIntent?: Intent;
  at: number;
}

interface LabHandoffContextValue {
  handoff: LabHandoff | null;
  setHandoff: (handoff: LabHandoff | null) => void;
}

const LabHandoffContext = createContext<LabHandoffContextValue | null>(null);

export function LabHandoffProvider({ children }: { children: ReactNode }) {
  const [handoff, setHandoffState] = useState<LabHandoff | null>(null);
  const setHandoff = useCallback((next: LabHandoff | null) => {
    setHandoffState(next);
  }, []);

  const value = useMemo(() => ({ handoff, setHandoff }), [handoff, setHandoff]);
  return (
    <LabHandoffContext.Provider value={value}>
      {children}
    </LabHandoffContext.Provider>
  );
}

export function useLabHandoff(): LabHandoffContextValue {
  const value = useContext(LabHandoffContext);
  if (!value) throw new Error('useLabHandoff must be used inside LabHandoffProvider');
  return value;
}
