interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  id: string;
}

export default function Toggle({ checked, onChange, label, id }: ToggleProps) {
  return (
    <label className="toggle" htmlFor={id}>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        className="toggle__track"
        data-on={checked || undefined}
        onClick={() => onChange(!checked)}
      >
        <span className="toggle__thumb" />
      </button>
      <span className="toggle__label">{label}</span>
    </label>
  );
}
