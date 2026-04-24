#![cfg_attr(not(any(feature = "library", test)), no_std)]
#![cfg_attr(not(test), no_main)]

#[cfg(any(feature = "library", test))]
extern crate alloc;

use ckb_std::{
    ckb_constants::Source,
    error::SysError,
    high_level::{load_cell_data, load_cell_lock_hash, load_script},
};

#[cfg(not(any(feature = "library", test)))]
ckb_std::entry!(program_entry);
#[cfg(not(any(feature = "library", test)))]
// By default, the following heap configuration is used:
// * 16KB fixed heap
// * 1.2MB(rounded up to be 16-byte aligned) dynamic heap
// * Minimal memory block in dynamic heap is 64 bytes
// For more details, please refer to ckb-std's default_alloc macro
// and the buddy-alloc alloc implementation.
ckb_std::default_alloc!(16384, 1258306, 64);

const TYPE_ID_ARGS_LEN: usize = 32;
const MAX_DATA_LEN: usize = 1024;
const MIN_DATA_LEN: usize = 24;

#[repr(i8)]
enum Error {
    IndexOutOfBound = 1,
    ItemMissing,
    LengthNotEnough,
    Encoding,
    Unknown,
    InvalidArgsLen = 10,
    InvalidGroupInputCount,
    InvalidGroupOutputCount,
    LockScriptChanged,
    InvalidDataFormat,
    MissingUrl,
    MissingPrice,
    InvalidUrl,
    DataTooLarge,
    DataTooSmall,
}

impl From<SysError> for Error {
    fn from(err: SysError) -> Self {
        match err {
            SysError::IndexOutOfBound => Self::IndexOutOfBound,
            SysError::ItemMissing => Self::ItemMissing,
            SysError::LengthNotEnough(_) => Self::LengthNotEnough,
            SysError::Encoding => Self::Encoding,
            _ => Self::Unknown,
        }
    }
}

fn count_cells(source: Source) -> Result<usize, Error> {
    let mut index = 0;
    loop {
        match load_cell_data(index, source) {
            Ok(_) => index += 1,
            Err(SysError::IndexOutOfBound) => return Ok(index),
            Err(err) => return Err(err.into()),
        }
    }
}

fn validate_registry_data(data: &[u8]) -> Result<(), Error> {
    if data.len() < MIN_DATA_LEN {
        return Err(Error::DataTooSmall);
    }
    if data.len() > MAX_DATA_LEN {
        return Err(Error::DataTooLarge);
    }

    let text = core::str::from_utf8(data).map_err(|_| Error::InvalidDataFormat)?;
    let normalized = text.trim();

    if !(normalized.starts_with('{') || normalized.starts_with('[')) {
        return Err(Error::InvalidDataFormat);
    }

    if !(normalized.ends_with('}') || normalized.ends_with(']')) {
        return Err(Error::InvalidDataFormat);
    }

    if !normalized.contains("\"url\"") {
        return Err(Error::MissingUrl);
    }

    if !normalized.contains("\"price\"") {
        return Err(Error::MissingPrice);
    }

    if !(normalized.contains("http://") || normalized.contains("https://")) {
        return Err(Error::InvalidUrl);
    }

    Ok(())
}

fn main() -> Result<(), Error> {
    let script = load_script().map_err(Error::from)?;
    let args = script.args().raw_data();

    if args.len() != TYPE_ID_ARGS_LEN {
        return Err(Error::InvalidArgsLen);
    }

    let input_count = count_cells(Source::GroupInput)?;
    let output_count = count_cells(Source::GroupOutput)?;

    if input_count > 1 {
        return Err(Error::InvalidGroupInputCount);
    }

    if output_count != 1 {
        return Err(Error::InvalidGroupOutputCount);
    }

    if input_count == 1 {
        let input_lock_hash = load_cell_lock_hash(0, Source::GroupInput).map_err(Error::from)?;
        let output_lock_hash = load_cell_lock_hash(0, Source::GroupOutput).map_err(Error::from)?;
        if input_lock_hash != output_lock_hash {
            return Err(Error::LockScriptChanged);
        }
    }

    let output_data = load_cell_data(0, Source::GroupOutput).map_err(Error::from)?;
    validate_registry_data(output_data.as_slice())?;

    Ok(())
}

pub fn program_entry() -> i8 {
    match main() {
        Ok(()) => 0,
        Err(err) => err as i8,
    }
}
