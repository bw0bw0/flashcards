import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";

interface Props {
  title: string;
  subtitle?: string | null;
  /** Shows a back arrow that returns to the previous screen. */
  back?: boolean;
  actions?: ReactNode;
  children: ReactNode;
}

/** Standard page frame: a sticky top bar over a scrolling body. */
export function Screen({ title, subtitle, back, actions, children }: Props) {
  const navigate = useNavigate();
  return (
    <>
      <div className="topbar">
        {back && (
          <button className="icon-btn" onClick={() => navigate(-1)} aria-label="Back">
            ←
          </button>
        )}
        <h1>
          {title}
          {subtitle && <span className="subtitle">{subtitle}</span>}
        </h1>
        {actions}
      </div>
      <div className="content">{children}</div>
    </>
  );
}

export function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="error-banner">{message}</div>;
}
