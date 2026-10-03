//! Timelapse Studio — движок сборки роликов.
pub mod beats;
pub mod encoder;
pub mod error;
pub mod graph;
pub mod looks;
pub mod pipeline;
pub mod probe;
pub mod project;
pub mod render;
pub mod tools;
pub mod util;

pub use error::{Error, Result};
