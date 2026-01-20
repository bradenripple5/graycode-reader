#!/usr/bin/env python3
import argparse
import json
from pathlib import Path


def lcm(a: int, b: int) -> int:
    while b:
        a, b = b, a % b
    return a


def lcm_list(values):
    result = values[0]
    for v in values[1:]:
        # compute lcm via gcd
        a, b = result, v
        while b:
            a, b = b, a % b
        gcd = a
        result = result * v // gcd
    return result


def parse_column(text: str) -> list[int]:
    return [int(v.strip()) for v in text.strip().split(",") if v.strip() != ""]


def load_rings(path: Path) -> list[list[int]]:
    data = json.loads(path.read_text())
    rings = data.get("rings")
    if not rings:
        raise SystemExit("pattern.json missing 'rings'")
    return rings


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Map a column of ring bits to angle(s) using pattern.json."
    )
    parser.add_argument(
        "--pattern",
        default="pattern.json",
        help="Path to pattern.json (default: ./pattern.json).",
    )
    parser.add_argument(
        "--column",
        help='Comma-separated column bits (e.g. "1,0,1,0,1,0,1"). If omitted, read from stdin.',
    )
    args = parser.parse_args()

    if args.column:
        column_text = args.column
    else:
        column_text = input("Enter column bits (comma-separated): ")

    column = parse_column(column_text)
    rings = load_rings(Path(args.pattern))

    if len(column) != len(rings):
        raise SystemExit(
            f"Column length {len(column)} does not match ring count {len(rings)}."
        )

    ring_lengths = [len(r) for r in rings]
    total_cols = lcm_list(ring_lengths)

    matches = []
    for i in range(total_cols):
        ok = True
        for ring_idx, ring in enumerate(rings):
            segs = len(ring)
            seg_len = total_cols // segs
            idx = i // seg_len
            if ring[idx] != column[ring_idx]:
                ok = False
                break
        if ok:
            angle = (i * 360.0) / total_cols
            matches.append(angle)

    if not matches:
        print("No matching angle found.")
        return

    print(f"Matches: {len(matches)}")
    for angle in matches:
        print(f"{angle:.3f}°")


if __name__ == "__main__":
    main()
