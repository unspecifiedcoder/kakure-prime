/** A wait shown as a sequence with an ETA per step, never a lone spinner. `current` marks the active
 *  step; earlier ones render as done. */
export interface Step {
  id: string;
  label: string;
  eta?: string;
}

export function Steps({ steps, current, done }: { steps: readonly Step[]; current?: string | undefined; done?: boolean | undefined }): JSX.Element {
  const idx = current ? steps.findIndex((s) => s.id === current) : -1;
  return (
    <ol className="steps" aria-label="Progress">
      {steps.map((s, i) => {
        const state = done || i < idx ? "done" : i === idx ? "active" : "todo";
        return (
          <li key={s.id} data-state={state} aria-current={state === "active" ? "step" : undefined}>
            <span className="dot" aria-hidden="true" />
            <span>{s.label}</span>
            <span className="eta">{state === "active" && s.eta ? s.eta : ""}</span>
          </li>
        );
      })}
    </ol>
  );
}
