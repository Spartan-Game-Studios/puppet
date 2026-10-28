//! Pixel conversions from the frontend's frame format (8-bit BGRA, top-down,
//! tightly packed, alpha already composited) to what each OS sink wants.
//!
//! - macOS CoreMediaIO: BGRA as-is (`kCVPixelFormatType_32BGRA`).
//! - Linux v4l2loopback: YUYV 4:2:2 (`V4L2_PIX_FMT_YUYV`), the format every
//!   V4L2 consumer accepts.
//! - Windows softcam: 24-bit BGR, top-down (softcam flips to a DIB itself).
//!
//! YUV uses BT.601 limited range ("studio swing", Y 16..235, C 16..240),
//! which is what V4L2 consumers assume for webcam YUYV.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PixelFormat {
    /// 4 bytes per pixel: B, G, R, A.
    Bgra,
    /// 2 bytes per pixel: Y0 U Y1 V per pixel pair.
    Yuyv,
    /// 3 bytes per pixel: B, G, R.
    Bgr24,
}

impl PixelFormat {
    pub fn frame_bytes(self, width: u32, height: u32) -> usize {
        let px = width as usize * height as usize;
        match self {
            PixelFormat::Bgra => px * 4,
            PixelFormat::Yuyv => px * 2,
            PixelFormat::Bgr24 => px * 3,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            PixelFormat::Bgra => "BGRA",
            PixelFormat::Yuyv => "YUYV",
            PixelFormat::Bgr24 => "BGR24",
        }
    }
}

#[inline(always)]
fn y601(r: i32, g: i32, b: i32) -> u8 {
    (((66 * r + 129 * g + 25 * b + 128) >> 8) + 16) as u8
}

/// BGRA (top-down) -> YUYV 4:2:2. Chroma of each horizontal pixel pair is
/// computed from the pair's average colour. `width` must be even.
pub fn bgra_to_yuyv(src: &[u8], width: u32, height: u32, dst: &mut [u8]) {
    let (w, h) = (width as usize, height as usize);
    assert!(w % 2 == 0, "YUYV needs an even width");
    assert!(src.len() >= w * h * 4 && dst.len() >= w * h * 2, "buffer too small");
    for (srow, drow) in src.chunks_exact(w * 4).zip(dst.chunks_exact_mut(w * 2)).take(h) {
        for (s, d) in srow.chunks_exact(8).zip(drow.chunks_exact_mut(4)) {
            let (b0, g0, r0) = (s[0] as i32, s[1] as i32, s[2] as i32);
            let (b1, g1, r1) = (s[4] as i32, s[5] as i32, s[6] as i32);
            // Sum of the pair; the >> 9 below folds in the /2 of the average.
            let (r, g, b) = (r0 + r1, g0 + g1, b0 + b1);
            d[0] = y601(r0, g0, b0);
            d[1] = (((-38 * r - 74 * g + 112 * b + 256) >> 9) + 128) as u8;
            d[2] = y601(r1, g1, b1);
            d[3] = (((112 * r - 94 * g - 18 * b + 256) >> 9) + 128) as u8;
        }
    }
}

/// BGRA (top-down) -> packed BGR24 (top-down).
pub fn bgra_to_bgr24(src: &[u8], width: u32, height: u32, dst: &mut [u8]) {
    let n = width as usize * height as usize;
    assert!(src.len() >= n * 4 && dst.len() >= n * 3, "buffer too small");
    for (s, d) in src.chunks_exact(4).zip(dst.chunks_exact_mut(3)).take(n) {
        d.copy_from_slice(&s[..3]);
    }
}

/// Convert into `dst` (resized as needed). BGRA is a straight copy.
pub fn convert(src: &[u8], width: u32, height: u32, to: PixelFormat, dst: &mut Vec<u8>) {
    dst.resize(to.frame_bytes(width, height), 0);
    match to {
        PixelFormat::Bgra => {
            let n = dst.len();
            dst.copy_from_slice(&src[..n])
        }
        PixelFormat::Yuyv => bgra_to_yuyv(src, width, height, dst),
        PixelFormat::Bgr24 => bgra_to_bgr24(src, width, height, dst),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(w: u32, h: u32, bgra: [u8; 4]) -> Vec<u8> {
        bgra.iter().copied().cycle().take((w * h * 4) as usize).collect()
    }

    /// Reference BT.601 limited-range conversion in floating point.
    fn ref_yuv(r: f64, g: f64, b: f64) -> (f64, f64, f64) {
        let y = 16.0 + (65.481 * r + 128.553 * g + 24.966 * b) / 255.0;
        let u = 128.0 + (-37.797 * r - 74.203 * g + 112.0 * b) / 255.0;
        let v = 128.0 + (112.0 * r - 93.786 * g - 18.214 * b) / 255.0;
        (y, u, v)
    }

    #[test]
    fn yuyv_matches_reference_for_key_colours() {
        // Chroma green, blue, magenta, black, white, mid grey.
        for (r, g, b) in [(0, 255, 0), (0, 0, 255), (255, 0, 255), (0, 0, 0), (255, 255, 255), (128, 128, 128), (255, 59, 0)] {
            let src = solid(4, 2, [b, g, r, 255]);
            let mut dst = vec![0u8; 4 * 2 * 2];
            bgra_to_yuyv(&src, 4, 2, &mut dst);
            let (y, u, v) = ref_yuv(r as f64, g as f64, b as f64);
            for px in dst.chunks_exact(4) {
                assert!((px[0] as f64 - y).abs() <= 1.0, "Y {} vs {y} for {r},{g},{b}", px[0]);
                assert!((px[2] as f64 - y).abs() <= 1.0, "Y1 {} vs {y}", px[2]);
                assert!((px[1] as f64 - u).abs() <= 1.0, "U {} vs {u} for {r},{g},{b}", px[1]);
                assert!((px[3] as f64 - v).abs() <= 1.0, "V {} vs {v} for {r},{g},{b}", px[3]);
            }
        }
    }

    #[test]
    fn yuyv_black_and_white_hit_studio_range() {
        let mut d = vec![0u8; 4];
        bgra_to_yuyv(&[0, 0, 0, 255, 0, 0, 0, 255], 2, 1, &mut d);
        assert_eq!(d, [16, 128, 16, 128]);
        bgra_to_yuyv(&[255, 255, 255, 255, 255, 255, 255, 255], 2, 1, &mut d);
        assert_eq!(d, [235, 128, 235, 128]);
    }

    #[test]
    fn yuyv_keeps_per_pixel_luma_and_averages_chroma() {
        // Left pixel black, right pixel white: lumas differ, chroma neutral.
        let mut d = vec![0u8; 4];
        bgra_to_yuyv(&[0, 0, 0, 255, 255, 255, 255, 255], 2, 1, &mut d);
        assert_eq!(d[0], 16);
        assert_eq!(d[2], 235);
        assert!((d[1] as i32 - 128).abs() <= 1 && (d[3] as i32 - 128).abs() <= 1);
    }

    #[test]
    fn yuyv_row_order_is_preserved() {
        // Top row white, bottom row black: YUYV stays top-down.
        let mut src = solid(2, 2, [0, 0, 0, 255]);
        src[..8].copy_from_slice(&[255; 8]);
        let mut d = vec![0u8; 8];
        bgra_to_yuyv(&src, 2, 2, &mut d);
        assert_eq!(d[0], 235);
        assert_eq!(d[4], 16);
    }

    #[test]
    fn bgr24_drops_alpha_and_keeps_order() {
        let src = [1, 2, 3, 255, 4, 5, 6, 0];
        let mut d = vec![0u8; 6];
        bgra_to_bgr24(&src, 2, 1, &mut d);
        assert_eq!(d, [1, 2, 3, 4, 5, 6]);
    }

    #[test]
    fn convert_sizes_output() {
        let src = solid(8, 4, [0, 255, 0, 255]);
        let mut out = Vec::new();
        for (fmt, bpp) in [(PixelFormat::Bgra, 4), (PixelFormat::Yuyv, 2), (PixelFormat::Bgr24, 3)] {
            convert(&src, 8, 4, fmt, &mut out);
            assert_eq!(out.len(), 8 * 4 * bpp, "{}", fmt.name());
        }
        convert(&src, 8, 4, PixelFormat::Bgra, &mut out);
        assert_eq!(out, src);
    }
}
