//! Little-endian fixed fields, LEB128 varints and zigzag deltas.

use super::{DecodeError, EncodeError};

pub(super) struct Writer(pub(super) Vec<u8>);

impl Writer {
    pub(super) fn u8(&mut self, v: u8) {
        self.0.push(v);
    }

    pub(super) fn u16(&mut self, v: u16) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }

    pub(super) fn u32(&mut self, v: u32) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }

    pub(super) fn u64(&mut self, v: u64) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }

    pub(super) fn varint(&mut self, mut v: u64) {
        while v >= 0x80 {
            self.0.push((v as u8) | 0x80);
            v >>= 7;
        }
        self.0.push(v as u8);
    }

    /// `cur` as a zigzag varint of its difference from `prev`.
    pub(super) fn delta(&mut self, prev: u32, cur: u32) {
        let d = i64::from(cur) - i64::from(prev);
        self.varint(((d << 1) ^ (d >> 63)) as u64);
    }

    /// A length byte and UTF-8.
    pub(super) fn str(&mut self, s: &str) -> Result<(), EncodeError> {
        if s.len() > super::MAX_STR {
            return Err(EncodeError::StringTooLong);
        }
        self.u8(s.len() as u8);
        self.0.extend_from_slice(s.as_bytes());
        Ok(())
    }

    /// A tag, then a varint length and the body `put` writes, so a reader
    /// can skip a tag it does not know.
    pub(super) fn framed(
        &mut self,
        tag: u8,
        put: impl FnOnce(&mut Writer) -> Result<(), EncodeError>,
    ) -> Result<(), EncodeError> {
        let mut body = Writer(Vec::new());
        put(&mut body)?;
        self.u8(tag);
        self.varint(body.0.len() as u64);
        self.0.extend_from_slice(&body.0);
        Ok(())
    }
}

pub(super) struct Reader<'a> {
    bytes: &'a [u8],
}

impl<'a> Reader<'a> {
    pub(super) fn new(bytes: &'a [u8]) -> Self {
        Self { bytes }
    }

    pub(super) fn remaining(&self) -> usize {
        self.bytes.len()
    }

    pub(super) fn finish(self) -> Result<(), DecodeError> {
        if self.bytes.is_empty() {
            Ok(())
        } else {
            Err(DecodeError::Trailing)
        }
    }

    fn take<const N: usize>(&mut self) -> Result<[u8; N], DecodeError> {
        let (head, rest) = self
            .bytes
            .split_first_chunk::<N>()
            .ok_or(DecodeError::Truncated)?;
        self.bytes = rest;
        Ok(*head)
    }

    fn slice(&mut self, n: usize) -> Result<&'a [u8], DecodeError> {
        if n > self.bytes.len() {
            return Err(DecodeError::Truncated);
        }
        let (head, rest) = self.bytes.split_at(n);
        self.bytes = rest;
        Ok(head)
    }

    /// A tag and the body that follows its length. A reader of the body that
    /// stops early leaves the rest unread, so fields can be appended later.
    pub(super) fn framed(&mut self) -> Result<(u8, Reader<'a>), DecodeError> {
        let tag = self.u8()?;
        let len = usize::try_from(self.varint()?).map_err(|_| DecodeError::Truncated)?;
        Ok((tag, Reader::new(self.slice(len)?)))
    }

    pub(super) fn u8(&mut self) -> Result<u8, DecodeError> {
        Ok(self.take::<1>()?[0])
    }

    pub(super) fn u16(&mut self) -> Result<u16, DecodeError> {
        Ok(u16::from_le_bytes(self.take()?))
    }

    pub(super) fn u32(&mut self) -> Result<u32, DecodeError> {
        Ok(u32::from_le_bytes(self.take()?))
    }

    pub(super) fn u64(&mut self) -> Result<u64, DecodeError> {
        Ok(u64::from_le_bytes(self.take()?))
    }

    pub(super) fn varint(&mut self) -> Result<u64, DecodeError> {
        let mut v = 0u64;
        for shift in (0..70).step_by(7) {
            let b = self.u8()?;
            let bits = u64::from(b & 0x7f);
            // The tenth byte may only carry the top bit of a u64.
            if shift == 63 && bits > 1 {
                return Err(DecodeError::Invalid("varint overflows u64"));
            }
            v |= bits << shift;
            if b & 0x80 == 0 {
                // A zero last byte after the first is padding. One value has one encoding.
                if b == 0 && shift > 0 {
                    return Err(DecodeError::Invalid("varint is not canonical"));
                }
                return Ok(v);
            }
        }
        Err(DecodeError::Invalid("varint too long"))
    }

    pub(super) fn varint_u32(&mut self) -> Result<u32, DecodeError> {
        u32::try_from(self.varint()?).map_err(|_| DecodeError::Invalid("varint overflows u32"))
    }

    pub(super) fn delta(&mut self, prev: u32) -> Result<u32, DecodeError> {
        let z = self.varint()?;
        let d = ((z >> 1) as i64) ^ -((z & 1) as i64);
        i64::from(prev)
            .checked_add(d)
            .and_then(|v| u32::try_from(v).ok())
            .ok_or(DecodeError::Invalid("delta leaves u32"))
    }

    /// An element count. Every element takes at least a byte, so a count past
    /// the bytes left is truncation, and nothing is allocated for it.
    pub(super) fn count(&mut self) -> Result<usize, DecodeError> {
        let n = usize::try_from(self.varint()?).map_err(|_| DecodeError::Truncated)?;
        if n > self.bytes.len() {
            return Err(DecodeError::Truncated);
        }
        Ok(n)
    }

    pub(super) fn str(&mut self) -> Result<String, DecodeError> {
        let n = usize::from(self.u8()?);
        if n > super::MAX_STR {
            return Err(DecodeError::Invalid("string is too long"));
        }
        String::from_utf8(self.slice(n)?.to_vec())
            .map_err(|_| DecodeError::Invalid("string is not UTF-8"))
    }
}
