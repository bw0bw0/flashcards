import { NavLink, Outlet } from "react-router-dom";

const TABS = [
  { to: "/", icon: "🗂", label: "Decks" },
  { to: "/study", icon: "🎯", label: "Study" },
  { to: "/prompts", icon: "✨", label: "Prompts" },
];

/** The tabbed shell; training screens render outside it, full height. */
export function Layout() {
  return (
    <>
      <Outlet />
      <nav className="navbar">
        {TABS.map((tab) => (
          <NavLink key={tab.to} to={tab.to} end={tab.to === "/"}>
            <span className="icon">{tab.icon}</span>
            {tab.label}
          </NavLink>
        ))}
      </nav>
    </>
  );
}
