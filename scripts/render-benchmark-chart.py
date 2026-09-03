#!/usr/bin/env python3
"""Render the README benchmark chart from the retained run manifests."""

from __future__ import annotations

import json
from html import escape
from pathlib import Path
from statistics import fmean


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "docs" / "assets" / "benchmark-comparison.svg"


def load_json(relative_path: str) -> dict:
    return json.loads((ROOT / relative_path).read_text(encoding="utf-8"))


def ratio(numerator: float, denominator: float) -> float:
    return numerator / denominator


def build_rows() -> list[dict]:
    finca = load_json(
        "benchmarks/fincaraiz/2026-09-04-cold-pairs-summary.json"
    )
    finca_trials = finca["trials"]

    def finca_average(arm: str, field: str) -> float:
        return fmean(trial[arm][field] for trial in finca_trials)

    metro_meta = load_json(
        "benchmarks/metrocuadrado/2026-09-04-metawebmcp-cold-run.json"
    )
    metro_direct = load_json(
        "benchmarks/metrocuadrado/2026-09-04-browser-fresh-run.json"
    )
    steam_meta = load_json(
        "benchmarks/steam/2026-09-04-metawebmcp-cold-run.json"
    )
    steam_direct = load_json(
        "benchmarks/steam/2026-09-04-browser-fresh-run.json"
    )

    return [
        {
            "name": "FincaRaíz average",
            "scope": "2 matched runs · 13 pages each",
            "values": [
                ratio(
                    finca_average("directBrowser", "wallMs"),
                    finca_average("metaWebMcp", "wallMs"),
                ),
                ratio(
                    finca_average("directBrowser", "processedTokens"),
                    finca_average("metaWebMcp", "processedTokens"),
                ),
                ratio(
                    finca_average("directBrowser", "nonCachedTokens"),
                    finca_average("metaWebMcp", "nonCachedTokens"),
                ),
                ratio(
                    finca_average(
                        "directBrowser", "modelFacingResponseCharacters"
                    ),
                    finca_average(
                        "metaWebMcp", "modelFacingResponseCharacters"
                    ),
                ),
            ],
        },
        {
            "name": "Metrocuadrado",
            "scope": "1 lazy-loaded results page",
            "values": [
                ratio(
                    metro_direct["timing"]["wallMs"],
                    metro_meta["timing"]["wallMs"],
                ),
                ratio(
                    metro_direct["agent"]["tokenUsage"]["processedTotal"],
                    metro_meta["agent"]["tokenUsage"]["processedTotal"],
                ),
                ratio(
                    metro_direct["agent"]["tokenUsage"]["nonCachedTotal"],
                    metro_meta["agent"]["tokenUsage"]["nonCachedTotal"],
                ),
                ratio(
                    metro_direct["agent"]["browserResponseCharacters"],
                    metro_meta["agent"]["semanticResponseCharacters"],
                ),
            ],
        },
        {
            "name": "Steam",
            "scope": "20 pages · 500 result cards",
            "values": [
                ratio(
                    steam_direct["timing"]["wallMs"],
                    steam_meta["timing"]["wallMs"],
                ),
                ratio(
                    steam_direct["agent"]["tokenUsage"]["processedTotal"],
                    steam_meta["agent"]["tokenUsage"]["processedTotal"],
                ),
                ratio(
                    steam_direct["agent"]["tokenUsage"]["nonCachedTotal"],
                    steam_meta["agent"]["tokenUsage"]["nonCachedTotal"],
                ),
                ratio(
                    steam_direct["agent"]["semanticResponseCharacters"],
                    steam_meta["agent"]["semanticResponseCharacters"],
                ),
            ],
        },
    ]


def render_svg(rows: list[dict]) -> str:
    width = 1500
    height = 690
    cell_width = 258
    cell_height = 106
    cell_gap = 18
    cell_x = [326 + index * (cell_width + cell_gap) for index in range(4)]
    row_y = [226, 360, 494]
    metric_names = [
        ("WALL TIME", "completion speed"),
        ("PROCESSED TOKENS", "total token efficiency"),
        ("NON-CACHED TOKENS", "new token efficiency"),
        ("TOOL-RESPONSE TEXT", "context efficiency"),
    ]
    maxima = [max(row["values"][index] for row in rows) for index in range(4)]
    fragments = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img" aria-labelledby="chart-title chart-desc">',
        '<title id="chart-title">MetaWebMCP live-site benchmark comparison</title>',
        '<desc id="chart-desc">Direct browser usage divided by MetaWebMCP usage for wall time, processed tokens, non-cached tokens, and model-facing tool-response text. Higher is better. FincaRaíz has the highest value in all four columns. Metrocuadrado is below parity for wall time and processed tokens but above parity for non-cached tokens and tool-response text. Steam is above parity in all four columns.</desc>',
        "<defs>",
        '<filter id="shadow" x="-10%" y="-15%" width="120%" height="140%"><feDropShadow dx="0" dy="5" stdDeviation="8" flood-color="#17201e" flood-opacity="0.08"/></filter>',
        "</defs>",
        '<rect x="1" y="1" width="1498" height="688" rx="24" fill="#f7f5ee" stroke="#d2cfc5" stroke-width="2"/>',
        '<rect x="1" y="1" width="1498" height="8" rx="4" fill="#1747d1"/>',
        '<circle cx="58" cy="63" r="7" fill="#ff6738"/><circle cx="58" cy="63" r="14" fill="none" stroke="#ff6738" stroke-opacity="0.20" stroke-width="6"/>',
        '<text x="84" y="73" fill="#17201e" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="32" font-weight="750" letter-spacing="-0.7">Live-site benchmark</text>',
        '<text x="54" y="109" fill="#55615d" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="16">Direct browser ÷ MetaWebMCP · higher is better · 1× is parity</text>',
        '<rect x="1252" y="47" width="190" height="40" rx="20" fill="#eef2ff" stroke="#bdc9f7"/>',
        '<text x="1347" y="72" text-anchor="middle" fill="#1747d1" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="14" font-weight="750">↑ HIGHER IS BETTER</text>',
        '<line x1="54" y1="139" x2="1446" y2="139" stroke="#d2cfc5"/>',
        '<text x="54" y="183" fill="#55615d" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="13" font-weight="750" letter-spacing="1.2">BENCHMARK TASK</text>',
    ]

    for x, (name, subtitle) in zip(cell_x, metric_names):
        fragments.extend(
            [
                f'<text x="{x + 2}" y="175" fill="#17201e" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="15" font-weight="800" letter-spacing="0.5">{escape(name)}</text>',
                f'<text x="{x + 2}" y="198" fill="#5b6561" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="13">{escape(subtitle)}</text>',
            ]
        )

    for row, y in zip(rows, row_y):
        fragments.extend(
            [
                f'<text x="54" y="{y + 36}" fill="#17201e" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="21" font-weight="750">{escape(row["name"])}</text>',
                f'<text x="54" y="{y + 64}" fill="#5b6561" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="14">{escape(row["scope"])}</text>',
            ]
        )

        for metric_index, (x, value) in enumerate(zip(cell_x, row["values"])):
            is_best = value == maxima[metric_index]
            is_regression = value < 1
            if is_best:
                fill = "#1747d1"
                stroke = "#0d328f"
                value_color = "#ffffff"
                note_color = "#dfe7ff"
                track_color = "#466be0"
                bar_color = "#ff9a77"
            elif is_regression:
                fill = "#fff2ed"
                stroke = "#efb39d"
                value_color = "#8f2f2b"
                note_color = "#9c5146"
                track_color = "#f5d4c8"
                bar_color = "#ff6738"
            else:
                fill = "#fffdf8"
                stroke = "#cbd3e8"
                value_color = "#17201e"
                note_color = "#55615d"
                track_color = "#e5e9f3"
                bar_color = "#1747d1"

            if value >= 1:
                comparison_note = (
                    "faster than direct parsing"
                    if metric_index == 0
                    else "fewer than direct parsing"
                    if metric_index in (1, 2)
                    else "less than direct parsing"
                )
            else:
                comparison_note = (
                    f"MetaWebMCP is {1 / value:.2f}× slower"
                    if metric_index == 0
                    else f"MetaWebMCP uses {1 / value:.2f}× more"
                )
            bar_width = max(8, round((cell_width - 40) * value / maxima[metric_index]))
            fragments.extend(
                [
                    f'<rect x="{x}" y="{y}" width="{cell_width}" height="{cell_height}" rx="14" fill="{fill}" stroke="{stroke}" stroke-width="{2 if is_best else 1}" filter="url(#shadow)"/>',
                    f'<text x="{x + 20}" y="{y + 43}" fill="{value_color}" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="28" font-weight="800" letter-spacing="-0.4">{value:.2f}×</text>',
                    f'<text x="{x + 20}" y="{y + 65}" fill="{note_color}" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="13" font-weight="650">{comparison_note}</text>',
                    f'<rect x="{x + 20}" y="{y + 82}" width="{cell_width - 40}" height="7" rx="3.5" fill="{track_color}"/>',
                    f'<rect x="{x + 20}" y="{y + 82}" width="{bar_width}" height="7" rx="3.5" fill="{bar_color}"/>',
                ]
            )
            if is_best:
                fragments.extend(
                    [
                        f'<rect x="{x + cell_width - 67}" y="{y + 15}" width="50" height="24" rx="12" fill="#fffdf8"/>',
                        f'<text x="{x + cell_width - 42}" y="{y + 31}" text-anchor="middle" fill="#1747d1" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="10" font-weight="850" letter-spacing="0.8">BEST</text>',
                    ]
                )

    fragments.extend(
        [
            '<line x1="54" y1="626" x2="1446" y2="626" stroke="#d2cfc5"/>',
            '<text x="54" y="659" fill="#55615d" font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="14">All outputs passed their task-specific exactness gate. Cold analysis and tool authoring are included.</text>',
            '<text x="1446" y="659" text-anchor="end" fill="#5b6561" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12">2026-09-04 retained runs</text>',
            "</svg>",
        ]
    )
    return "\n".join(fragments) + "\n"


def main() -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(render_svg(build_rows()), encoding="utf-8")
    print(f"Wrote {OUTPUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
