"""Writer for the TBN1 container: a JSON header plus 8-byte aligned typed arrays.

Layout (little endian), then gzip-compressed as a whole:
    b"TBN1" | u32 header_len | header JSON (utf-8) | pad to 8 | array blobs...
Header: {"arrays": {name: [dtype, byteOffset, length]}, ...extra}
byteOffset is relative to the start of the (8-aligned) data section.
"""

from __future__ import annotations

import gzip
import json
import struct
from pathlib import Path

import numpy as np

DTYPES = {
    "i8": np.int8, "u8": np.uint8, "i16": np.int16, "u16": np.uint16,
    "i32": np.int32, "u32": np.uint32, "f32": np.float32, "f64": np.float64,
}
_NAME = {np.dtype(v): k for k, v in DTYPES.items()}


def encode(arrays: dict[str, np.ndarray], **extra) -> bytes:
    index = {}
    blobs = []
    off = 0
    for name, arr in arrays.items():
        a = np.ascontiguousarray(arr)
        if a.dtype not in _NAME:
            raise TypeError(f"{name}: unsupported dtype {a.dtype}")
        b = a.astype(a.dtype.newbyteorder("<"), copy=False).tobytes()
        index[name] = [_NAME[a.dtype], off, int(a.size)]
        pad = (-len(b)) % 8
        blobs.append(b + b"\0" * pad)
        off += len(b) + pad
    header = json.dumps({"arrays": index, **extra}, separators=(",", ":")).encode()
    head = b"TBN1" + struct.pack("<I", len(header)) + header
    head += b"\0" * ((-len(head)) % 8)
    return head + b"".join(blobs)


def write(path: Path, arrays: dict[str, np.ndarray], level: int = 6, **extra) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = gzip.compress(encode(arrays, **extra), compresslevel=level, mtime=0)
    path.write_bytes(data)
    return len(data)


def read(path: Path) -> tuple[dict[str, np.ndarray], dict]:
    raw = gzip.decompress(path.read_bytes())
    assert raw[:4] == b"TBN1"
    (hl,) = struct.unpack("<I", raw[4:8])
    header = json.loads(raw[8 : 8 + hl])
    base = 8 + hl
    base += (-base) % 8
    out = {}
    for name, (dt, off, n) in header["arrays"].items():
        out[name] = np.frombuffer(raw, dtype=DTYPES[dt], count=n, offset=base + off)
    return out, header
