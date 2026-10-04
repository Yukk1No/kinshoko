//! Rewrite PixAI v1.0's global-attention blocks to process queries in chunks.
//!
//! Each global block computes softmax(q·kᵀ)·v over 5184 tokens, so the score matrix alone is
//! 16 × 5184 × 5184 values (0.86 GB in FP16, 1.7 GB in FP32). Splitting q along the token
//! axis computes the same result chunk by chunk, so only one chunk's scores are alive at a
//! time. The rewrite works on the protobuf wire format and streams the weights, so it needs
//! little memory even for the 2 GB FP32 model.

use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::Path;

pub struct Chunking {
    /// Indices of the global-attention blocks (`/blocks.{i}/attn/...`).
    pub blocks: &'static [u32],
    /// Number of query chunks; the token count must be divisible by it.
    pub chunks: u32,
    /// SHA-256 of the rewritten file, to catch a rewrite that differs from the tested one.
    pub sha256: &'static str,
}

const MODEL_GRAPH: u64 = 7;
const GRAPH_NODE: u64 = 1;
const NODE_INPUT: u64 = 1;
const NODE_OUTPUT: u64 = 2;
const NODE_NAME: u64 = 3;
const NODE_OP_TYPE: u64 = 4;
const ATTR_NAME: u64 = 1;
const ATTR_I: u64 = 3;
const ATTR_TYPE: u64 = 20;
const ATTR_TYPE_INT: u64 = 2;
const NODE_ATTRIBUTE: u64 = 5;

/// A top-level field of a message: where its tag starts and where its payload is.
#[derive(Clone, Copy)]
struct Field {
    number: u64,
    start: u64,
    payload: u64,
    end: u64,
}

/// A buffered file reader that tracks its position so forward seeks keep the buffer.
struct Src {
    r: BufReader<File>,
    pos: u64,
}

impl Src {
    fn open(path: &Path) -> std::io::Result<Self> {
        Ok(Self { r: BufReader::with_capacity(1 << 20, File::open(path)?), pos: 0 })
    }

    fn goto(&mut self, target: u64) -> std::io::Result<()> {
        if target != self.pos {
            self.r.seek_relative(target as i64 - self.pos as i64)?;
            self.pos = target;
        }
        Ok(())
    }
}

impl Read for Src {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.r.read(buf)?;
        self.pos += n as u64;
        Ok(n)
    }
}

fn read_varint(r: &mut impl Read) -> std::io::Result<(u64, u64)> {
    let (mut v, mut shift, mut n) = (0u64, 0, 0u64);
    loop {
        let mut b = [0u8];
        r.read_exact(&mut b)?;
        n += 1;
        v |= ((b[0] & 0x7f) as u64) << shift;
        if b[0] & 0x80 == 0 {
            return Ok((v, n));
        }
        shift += 7;
        if shift > 63 {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "varint too long"));
        }
    }
}

/// List the fields of the message occupying `[start, end)` without reading payloads.
fn scan(r: &mut Src, start: u64, end: u64) -> std::io::Result<Vec<Field>> {
    r.goto(start)?;
    let mut pos = start;
    let mut out = Vec::new();
    while pos < end {
        let (tag, n) = read_varint(r)?;
        let (number, wire) = (tag >> 3, tag & 7);
        let (payload, end) = match wire {
            0 => (pos + n, pos + n + read_varint(r)?.1),
            1 => (pos + n, pos + n + 8),
            2 => {
                let (len, m) = read_varint(r)?;
                (pos + n + m, pos + n + m + len)
            }
            5 => (pos + n, pos + n + 4),
            _ => return Err(invalid(format!("wire type {wire}"))),
        };
        out.push(Field { number, start: pos, payload, end });
        pos = end;
        r.goto(pos)?;
    }
    Ok(out)
}

#[derive(Default)]
struct Node {
    name: String,
    op_type: String,
    inputs: Vec<String>,
    outputs: Vec<String>,
}

fn parse_node(buf: &[u8]) -> std::io::Result<Node> {
    let mut node = Node::default();
    let mut r = buf;
    while !r.is_empty() {
        let (tag, _) = read_varint(&mut r)?;
        match tag & 7 {
            0 => {
                read_varint(&mut r)?;
            }
            2 => {
                let (len, _) = read_varint(&mut r)?;
                let (v, rest) = r.split_at(len as usize);
                r = rest;
                let s = || String::from_utf8_lossy(v).into_owned();
                match tag >> 3 {
                    NODE_INPUT => node.inputs.push(s()),
                    NODE_OUTPUT => node.outputs.push(s()),
                    NODE_NAME => node.name = s(),
                    NODE_OP_TYPE => node.op_type = s(),
                    _ => {}
                }
            }
            1 => r = &r[8..],
            5 => r = &r[4..],
            w => return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, format!("wire type {w}"))),
        }
    }
    Ok(node)
}

fn put_varint(out: &mut Vec<u8>, mut v: u64) {
    loop {
        let b = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            out.push(b);
            return;
        }
        out.push(b | 0x80);
    }
}

fn put_bytes(out: &mut Vec<u8>, field: u64, data: &[u8]) {
    put_varint(out, field << 3 | 2);
    put_varint(out, data.len() as u64);
    out.extend_from_slice(data);
}

fn int_attr(name: &str, value: i64) -> Vec<u8> {
    let mut a = Vec::new();
    put_bytes(&mut a, ATTR_NAME, name.as_bytes());
    put_varint(&mut a, ATTR_I << 3);
    put_varint(&mut a, value as u64);
    put_varint(&mut a, ATTR_TYPE << 3);
    put_varint(&mut a, ATTR_TYPE_INT);
    a
}

/// A GraphProto `node` field (tag included).
fn node_field(op: &str, name: &str, inputs: &[&str], outputs: &[&str], attrs: &[(&str, i64)]) -> Vec<u8> {
    let mut n = Vec::new();
    for i in inputs {
        put_bytes(&mut n, NODE_INPUT, i.as_bytes());
    }
    for o in outputs {
        put_bytes(&mut n, NODE_OUTPUT, o.as_bytes());
    }
    put_bytes(&mut n, NODE_NAME, name.as_bytes());
    put_bytes(&mut n, NODE_OP_TYPE, op.as_bytes());
    for (k, v) in attrs {
        put_bytes(&mut n, NODE_ATTRIBUTE, &int_attr(k, *v));
    }
    let mut f = Vec::new();
    put_bytes(&mut f, GRAPH_NODE, &n);
    f
}

/// Replacement nodes for one block: Split(q) → per chunk MatMul, Softmax, MatMul → Concat.
fn chunked_nodes(prefix: &str, q: &str, kt: &str, v: &str, out: &str, chunks: u32) -> Vec<u8> {
    let parts: Vec<String> = (0..chunks).map(|i| format!("{prefix}qchunk_{i}")).collect();
    let part_refs: Vec<&str> = parts.iter().map(String::as_str).collect();
    // Without a `split` input, Split (opset 13+) cuts the axis into equal parts.
    let mut bytes = node_field("Split", &format!("{prefix}QSplit"), &[q], &part_refs, &[("axis", 2)]);
    let mut outs = Vec::new();
    for (i, part) in parts.iter().enumerate() {
        let (s, a, o) = (format!("{prefix}c{i}_scores"), format!("{prefix}c{i}_attn"), format!("{prefix}c{i}_out"));
        bytes.extend(node_field("MatMul", &format!("{prefix}c{i}_MatMul"), &[part, kt], &[&s], &[]));
        bytes.extend(node_field("Softmax", &format!("{prefix}c{i}_Softmax"), &[&s], &[&a], &[("axis", -1)]));
        bytes.extend(node_field("MatMul", &format!("{prefix}c{i}_MatMul_1"), &[&a, v], &[&o], &[]));
        outs.push(o);
    }
    let out_refs: Vec<&str> = outs.iter().map(String::as_str).collect();
    bytes.extend(node_field("Concat", &format!("{prefix}QConcat"), &out_refs, &[out], &[("axis", 2)]));
    bytes
}

enum Edit {
    Keep,
    Drop,
    Replace(Vec<u8>),
}

fn copy_range(r: &mut Src, w: &mut impl Write, start: u64, end: u64) -> std::io::Result<()> {
    r.goto(start)?;
    std::io::copy(&mut r.by_ref().take(end - start), w)?;
    Ok(())
}

fn invalid(msg: String) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, msg)
}

/// Write `src` with the attention of `c.blocks` chunked to `dest`.
pub fn chunk_attention(src: &Path, dest: &Path, c: &Chunking) -> std::io::Result<()> {
    let len = std::fs::metadata(src)?.len();
    let mut r = Src::open(src)?;
    let top = scan(&mut r, 0, len)?;
    let graph = *top.iter().find(|f| f.number == MODEL_GRAPH).ok_or_else(|| invalid("没有 graph".into()))?;
    let fields = scan(&mut r, graph.payload, graph.end)?;

    // Read the nodes (small) and index the ones we rewrite by name.
    let mut nodes = Vec::new();
    for (i, f) in fields.iter().enumerate() {
        if f.number == GRAPH_NODE {
            r.goto(f.payload)?;
            let mut buf = vec![0u8; (f.end - f.payload) as usize];
            r.read_exact(&mut buf)?;
            nodes.push((i, parse_node(&buf)?));
        }
    }
    let find = |name: &str| nodes.iter().find(|(_, n)| n.name == name).ok_or_else(|| invalid(format!("找不到节点 {name}")));
    let mut edits: Vec<Edit> = fields.iter().map(|_| Edit::Keep).collect();
    for b in c.blocks {
        let prefix = format!("/blocks.{b}/attn/");
        let (i_mm, mm) = find(&format!("{prefix}MatMul"))?;
        let (i_sm, sm) = find(&format!("{prefix}Softmax"))?;
        let (i_mm1, mm1) = find(&format!("{prefix}MatMul_1"))?;
        let shape_ok = mm.op_type == "MatMul"
            && sm.op_type == "Softmax"
            && mm1.op_type == "MatMul"
            && sm.inputs.first() == mm.outputs.first()
            && mm1.inputs.first() == sm.outputs.first()
            && mm.inputs.len() == 2
            && mm1.inputs.len() == 2;
        if !shape_ok {
            return Err(invalid(format!("{prefix} 的结构和预期不同")));
        }
        edits[*i_mm] = Edit::Replace(chunked_nodes(&prefix, &mm.inputs[0], &mm.inputs[1], &mm1.inputs[1], &mm1.outputs[0], c.chunks));
        edits[*i_sm] = Edit::Drop;
        edits[*i_mm1] = Edit::Drop;
    }

    let graph_len: u64 = fields
        .iter()
        .zip(&edits)
        .map(|(f, e)| match e {
            Edit::Keep => f.end - f.start,
            Edit::Drop => 0,
            Edit::Replace(b) => b.len() as u64,
        })
        .sum();

    let part = dest.with_extension("part");
    let mut w = BufWriter::with_capacity(1 << 20, File::create(&part)?);
    for f in &top {
        if f.number != MODEL_GRAPH {
            copy_range(&mut r, &mut w, f.start, f.end)?;
            continue;
        }
        let mut head = Vec::new();
        put_varint(&mut head, MODEL_GRAPH << 3 | 2);
        put_varint(&mut head, graph_len);
        w.write_all(&head)?;
        for (gf, e) in fields.iter().zip(&edits) {
            match e {
                Edit::Keep => copy_range(&mut r, &mut w, gf.start, gf.end)?,
                Edit::Drop => {}
                Edit::Replace(b) => w.write_all(b)?,
            }
        }
    }
    w.flush()?;
    drop(w);
    std::fs::rename(&part, dest)
}
