"""
Shared chart style
==================

One place that decides what every figure in this project looks like, so the
report reads as a single deck rather than fourteen unrelated plots.

Principles applied
------------------
* **Colourblind-safe palette** - the Okabe-Ito qualitative set, which stays
  distinguishable under deuteranopia, protanopia and tritanopia, plus a
  perceptually-uniform sequential map (``cividis``) for heatmaps.
* **No chartjunk** - no 3-D, no gradients, no boxes round the plot; the top and
  right spines are removed and grid lines are a single faint horizontal set.
* **Direct labelling** - values are written next to the mark wherever it fits,
  so the reader never has to bounce between a legend and the data.
* **Titles state the finding, not the field name** - "Electronics is 57% of
  revenue but only 44% of profit", not "Revenue by category".
* **Consistent money formatting** - thousands separators, k/M suffixes.
"""

from __future__ import annotations

import os
import textwrap

import matplotlib as mpl
import matplotlib.pyplot as plt
import seaborn as sns

def _in_notebook() -> bool:
    """True when imported from inside an IPython/Jupyter kernel."""
    try:
        from IPython import get_ipython           # noqa: PLC0415
        ip = get_ipython()
        return ip is not None and ip.__class__.__name__ == "ZMQInteractiveShell"
    except Exception:
        return False


# Headless by default (scripts must never try to open a window), but leave the
# notebook's inline backend alone so charts render in eda.ipynb.
if not _in_notebook():
    mpl.use("Agg")

# --- Okabe-Ito, the reference colourblind-safe qualitative palette ----------
OKABE_ITO = [
    "#0072B2",   # blue
    "#E69F00",   # orange
    "#009E73",   # bluish green
    "#CC79A7",   # reddish purple
    "#56B4E9",   # sky blue
    "#D55E00",   # vermillion
    "#F0E442",   # yellow
    "#7F7F7F",   # grey
]
INK = "#22252A"          # near-black for text
MUTED = "#6B7280"        # secondary text
GRID = "#DFE3E8"
ACCENT = OKABE_ITO[0]
ACCENT_2 = OKABE_ITO[1]
POSITIVE = "#009E73"
NEGATIVE = "#D55E00"
SEQ_CMAP = "cividis"     # perceptually uniform + colourblind safe
DIV_CMAP = "PuOr"        # diverging, safe for red-green deficiency

FIGSIZE = (11, 6)
DPI = 150


def apply_style() -> None:
    """Install the project style into matplotlib's global rcParams."""
    sns.set_theme(style="white", context="notebook")
    mpl.rcParams.update(
        {
            "figure.figsize": FIGSIZE,
            "figure.dpi": DPI,
            "savefig.dpi": DPI,
            "savefig.bbox": "tight",
            "savefig.facecolor": "white",
            "figure.facecolor": "white",
            "axes.facecolor": "white",
            "axes.prop_cycle": mpl.cycler(color=OKABE_ITO),
            "axes.edgecolor": GRID,
            "axes.linewidth": 1.0,
            "axes.labelcolor": MUTED,
            "axes.labelsize": 11,
            "axes.titlesize": 14,
            "axes.titleweight": "semibold",
            "axes.titlecolor": INK,
            "axes.titlelocation": "left",
            "axes.titlepad": 30,
            "axes.grid": True,
            "axes.axisbelow": True,
            "grid.color": GRID,
            "grid.linewidth": 0.8,
            "xtick.color": MUTED,
            "ytick.color": MUTED,
            "xtick.labelsize": 10,
            "ytick.labelsize": 10,
            "legend.frameon": False,
            "legend.fontsize": 10,
            "font.family": "DejaVu Sans",
            "font.size": 11,
            "text.color": INK,
            "lines.linewidth": 2.2,
            "lines.solid_capstyle": "round",
            "patch.edgecolor": "white",
            "patch.linewidth": 0.6,
        }
    )


# ---------------------------------------------------------------------------
# formatting helpers
# ---------------------------------------------------------------------------
def money(x: float, decimals: int = 0) -> str:
    """1_234_567 -> '£1.23M'."""
    sign = "-" if x < 0 else ""
    x = abs(x)
    if x >= 1_000_000:
        return f"{sign}£{x / 1_000_000:.2f}M"
    if x >= 10_000:
        return f"{sign}£{x / 1_000:.0f}k"
    if x >= 1_000:
        return f"{sign}£{x / 1_000:.1f}k"
    return f"{sign}£{x:,.{decimals}f}"


def money_axis(ax, axis: str = "y") -> None:
    fmt = mpl.ticker.FuncFormatter(lambda v, _: money(v))
    (ax.yaxis if axis == "y" else ax.xaxis).set_major_formatter(fmt)


def pct_axis(ax, axis: str = "y", decimals: int = 0) -> None:
    fmt = mpl.ticker.FuncFormatter(lambda v, _: f"{v:.{decimals}%}")
    (ax.yaxis if axis == "y" else ax.xaxis).set_major_formatter(fmt)


def style_axes(ax, xgrid: bool = False, ygrid: bool = True) -> None:
    """Strip the box, keep at most one faint set of grid lines."""
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    ax.spines["left"].set_color(GRID)
    ax.spines["bottom"].set_color(GRID)
    ax.grid(axis="y", visible=ygrid)
    ax.grid(axis="x", visible=xgrid)


def titles(ax, finding: str, detail: str = "", wrap_at: int = 92,
           detail_wrap_at: int = 118) -> None:
    """
    Headline = the finding, sub-headline = the supporting detail.

    Both are wrapped so a long, specific headline never runs off the canvas -
    the headline is allowed to be a sentence, because that is what makes a
    chart self-explanatory.
    """
    head = "\n".join(textwrap.wrap(finding, wrap_at)) or finding
    n_head_lines = head.count("\n") + 1
    ax.set_title(head, loc="left", pad=16 + 18 * n_head_lines)
    if detail:
        body = "\n".join(textwrap.wrap(detail, detail_wrap_at))
        ax.text(0.0, 1.012, body, transform=ax.transAxes, ha="left", va="bottom",
                fontsize=10.5, color=MUTED, linespacing=1.35)


def label_bars(ax, bars, fmt=money, offset: float = 0.01, horizontal: bool = False,
               color: str = INK, fontsize: int = 10) -> None:
    """Direct-label a bar container instead of relying on a value axis."""
    if horizontal:
        span = max(abs(b.get_width()) for b in bars) or 1
        for b in bars:
            w = b.get_width()
            ax.text(w + offset * span, b.get_y() + b.get_height() / 2, fmt(w),
                    va="center", ha="left", fontsize=fontsize, color=color)
    else:
        span = max(abs(b.get_height()) for b in bars) or 1
        for b in bars:
            h = b.get_height()
            va = "bottom" if h >= 0 else "top"
            ax.text(b.get_x() + b.get_width() / 2, h + (offset * span if h >= 0 else -offset * span),
                    fmt(h), ha="center", va=va, fontsize=fontsize, color=color)


def direct_labels(ax, items, min_gap: float = 0.085, x_range=(0.04, 0.74),
                  fontsize: float = 9.5, boxed: bool = True, leader: bool = True) -> None:
    """
    Direct-label a set of points without letting the labels collide.

    ``items`` is a sequence of ``(text, x_data, y_data, colour)``.  Labels keep
    their own x position (clamped into ``x_range``) but are pushed apart in y
    until every one is at least ``min_gap`` axes-fractions from its neighbour,
    then joined back to their point with a hairline leader.  This is the
    "direct labelling beats a legend" principle made safe for dense plots.
    """
    ax.figure.canvas.draw()                       # transforms must be current
    inv = ax.transAxes.inverted()
    placed = []
    for text, x, y, colour in items:
        xa, ya = inv.transform(ax.transData.transform((x, y)))
        placed.append([text, float(x), float(y), float(xa), float(ya), colour])
    placed.sort(key=lambda t: t[4])
    for i in range(1, len(placed)):
        placed[i][4] = max(placed[i][4], placed[i - 1][4] + min_gap)
    overflow = placed[-1][4] - 0.96
    if overflow > 0:
        for pl in placed:
            pl[4] -= overflow
    for text, x, y, xa, ya, colour in placed:
        ax.annotate(
            text, xy=(x, y), xycoords="data",
            xytext=(min(max(xa, x_range[0]), x_range[1]),
                    min(max(ya, 0.03), 0.96)),
            textcoords=ax.transAxes, fontsize=fontsize, ha="left", va="center",
            color=INK, fontweight="semibold",
            bbox=(dict(boxstyle="round,pad=0.3", fc="white", ec=colour, lw=1.3, alpha=0.95)
                  if boxed else None),
            arrowprops=(dict(arrowstyle="-", color=colour, lw=1.0, alpha=0.8,
                             shrinkA=2, shrinkB=2) if leader else None),
        )


def source_note(fig, text: str = "Source: synthetic e-commerce ledger "
                                 "(data/generate_dataset.py), 2023-2025") -> None:
    fig.text(0.005, -0.02, text, ha="left", va="top", fontsize=8.5, color=MUTED)


def save(fig, path: str, note: str | None = None) -> str:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    source_note(fig) if note is None else source_note(fig, note)
    fig.savefig(path)
    plt.close(fig)
    return path


# ---------------------------------------------------------------------------
# squarified treemap (avoids a dependency on `squarify`)
# ---------------------------------------------------------------------------
def squarify(values, x: float, y: float, dx: float, dy: float) -> list[dict]:
    """
    Bruls/Huizing/van Wijk squarified treemap layout.

    ``values`` must be sorted descending; returns one rect dict per value.
    """
    values = list(values)
    total = float(sum(values))
    if total <= 0:
        return []
    scaled = [v * dx * dy / total for v in values]
    rects: list[dict] = []

    def worst(row, length):
        s = sum(row)
        if s == 0 or length == 0:
            return float("inf")
        rmax, rmin = max(row), min(row)
        return max((length ** 2) * rmax / (s ** 2), (s ** 2) / ((length ** 2) * rmin))

    def layout_row(row, x, y, dx, dy, horizontal):
        s = sum(row)
        out = []
        if horizontal:
            h = s / dx if dx else 0
            cx = x
            for r in row:
                w = r / h if h else 0
                out.append({"x": cx, "y": y, "dx": w, "dy": h})
                cx += w
            return out, x, y + h, dx, dy - h
        w = s / dy if dy else 0
        cy = y
        for r in row:
            h = r / w if w else 0
            out.append({"x": x, "y": cy, "dx": w, "dy": h})
            cy += h
        return out, x + w, y, dx - w, dy

    row: list[float] = []
    i = 0
    while i < len(scaled):
        horizontal = dx >= dy
        length = dx if horizontal else dy
        if not row or worst(row + [scaled[i]], length) <= worst(row, length):
            row.append(scaled[i])
            i += 1
        else:
            placed, x, y, dx, dy = layout_row(row, x, y, dx, dy, horizontal)
            rects.extend(placed)
            row = []
    if row:
        placed, x, y, dx, dy = layout_row(row, x, y, dx, dy, dx >= dy)
        rects.extend(placed)
    return rects
