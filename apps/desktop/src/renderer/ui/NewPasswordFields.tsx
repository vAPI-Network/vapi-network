import { strength } from "../password.js";
import { Field } from "./primitives.js";

export function NewPasswordFields({
  password,
  confirm,
  onPassword,
  onConfirm,
  label = "New password",
  hint = "It unlocks vAPI Desktop on this Mac.",
  autoFocus = false,
}: {
  password: string;
  confirm: string;
  onPassword: (value: string) => void;
  onConfirm: (value: string) => void;
  label?: string;
  hint?: string;
  autoFocus?: boolean;
}) {
  return (
    <>
      <Field
        label={label}
        type="password"
        autoFocus={autoFocus}
        value={password}
        onChange={(event) => onPassword(event.target.value)}
        hint={password.length > 0 ? strength(password).label : hint}
      />
      <Field
        label="Type it again"
        type="password"
        value={confirm}
        onChange={(event) => onConfirm(event.target.value)}
        {...(confirm.length > 0 && confirm !== password
          ? { error: "The two passwords are different." }
          : {})}
      />
    </>
  );
}
