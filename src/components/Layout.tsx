import { NavLink, Outlet } from "react-router-dom";

const TABS = [
  { to: "/", icon: "decks", label: "Decks" },
  { to: "/study", icon: "study", label: "Study" },
  { to: "/prompts", icon: "prompts", label: "Prompts" },
];

/** The tabbed shell; training screens render outside it, full height. */
export function Layout() {
  return (
    <>
      <Outlet />
      <nav className="navbar">
        {TABS.map((tab) => (
          <NavLink key={tab.to} to={tab.to} end={tab.to === "/"}>
            <span className="icon" data-icon={tab.icon} aria-hidden="true" />
            {tab.label}
          </NavLink>
        ))}
      </nav>
    </>
  );
}
