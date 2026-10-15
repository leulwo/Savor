const corners = ["top-left", "top-right", "bottom-right", "bottom-left"];

const cornerLines = [
  "M64 8H30V4H16V16H4V30H8V64",
  "M64 14H36V10H22V22H10V36H14V64",
  "M52 8V20H32V32H20V52H8",
  "M58 14V26H36V36H26V58H14",
  "M4 30H30V4M10 36H36V10",
];

export default function ClassicalMenuFrame() {
  return (
    <div className="classical-menu-frame" aria-hidden="true">
      {corners.map(corner => (
        <svg
          key={corner}
          className={`classical-menu-frame__corner classical-menu-frame__corner--${corner}`}
          viewBox="0 0 64 64"
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
          strokeLinecap="square"
          strokeLinejoin="miter"
          focusable="false"
        >
          {cornerLines.map((line, index) => (
            <path
              key={line}
              d={line}
              className={index === 0 ? "classical-menu-frame__outer-line" : undefined}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
      ))}
    </div>
  );
}
