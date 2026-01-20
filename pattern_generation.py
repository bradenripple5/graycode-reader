#!/usr/bin/env python3
import argparse
import json
from pathlib import Path


def gray_code(value: int) -> int:
    return value ^ (value >> 1)


def build_rings(sections: int, order: str) -> list[list[int]]:
    columns = 1 << sections
    rings = [[] for _ in range(sections)]

    for col in range(columns):
        code = gray_code(col) if order == "gray" else col
        for bit in range(sections):
            # Ring 0 is MSB (inner), last ring is LSB (outer).
            ring_idx = bit
            bit_idx = sections - 1 - bit
            rings[ring_idx].append((code >> bit_idx) & 1)

    return rings


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate a radial pattern.json with unique columns."
    )
    parser.add_argument(
        "sections",
        type=int,
        help="Number of radial sections (rings).",
    )
    parser.add_argument(
        "--order",
        choices=["gray", "binary"],
        default="gray",
        help="Column ordering (default: gray).",
    )
    parser.add_argument(
        "--output",
        default="pattern.json",
        help="Output path (default: pattern.json).",
    )
    args = parser.parse_args()

    if args.sections <= 0:
        raise SystemExit("sections must be > 0")

    rings = build_rings(args.sections, args.order)
    payload = {
        "rings": rings,
        "columns": 1 << args.sections,
        "order": args.order,
    }

    out_path = Path(args.output)
    out_path.write_text(json.dumps(payload, indent=2) + "\n")
    print(f"Wrote {out_path} with {len(rings)} rings and {payload['columns']} columns")


if __name__ == "__main__":
    main()
