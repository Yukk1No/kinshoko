//! 托盘图标上的新图数量（#368）。

use tauri::image::Image;

/// 托盘图标右上角的新图数量：圆点里写数字，超过 9 写“9+”。
pub fn badge(icon: &Image<'_>, count: u32) -> Image<'static> {
    let (w, h) = (icon.width() as i32, icon.height() as i32);
    let mut rgba = icon.rgba().to_vec();
    if count == 0 {
        return Image::new_owned(rgba, w as u32, h as u32);
    }
    let r = (w.min(h) as f32 * 0.3).max(4.0);
    let (cx, cy) = (w as f32 - r, r);
    let mut put = |x: i32, y: i32, c: [u8; 4]| {
        if (0..w).contains(&x) && (0..h).contains(&y) {
            let i = ((y * w + x) * 4) as usize;
            rgba[i..i + 4].copy_from_slice(&c);
        }
    };
    for y in 0..h {
        for x in 0..w {
            let d = ((x as f32 + 0.5 - cx).powi(2) + (y as f32 + 0.5 - cy).powi(2)).sqrt();
            if d <= r {
                put(x, y, [0xC8, 0x3A, 0x2E, 0xFF]);
            }
        }
    }
    let text = if count > 9 {
        "9+".to_owned()
    } else {
        count.to_string()
    };
    let scale = ((r * 1.1) / 5.0).floor().max(1.0) as i32;
    let glyph_w = 3 * scale;
    let width = text.len() as i32 * glyph_w + (text.len() as i32 - 1) * scale;
    let (x0, y0) = (cx as i32 - width / 2, cy as i32 - 5 * scale / 2);
    for (n, ch) in text.chars().enumerate() {
        let rows = glyph(ch);
        let gx = x0 + n as i32 * (glyph_w + scale);
        for (row, bits) in rows.iter().enumerate() {
            for col in 0..3 {
                if bits & (0b100 >> col) != 0 {
                    for dy in 0..scale {
                        for dx in 0..scale {
                            put(
                                gx + col * scale + dx,
                                y0 + row as i32 * scale + dy,
                                [0xFF, 0xFF, 0xFF, 0xFF],
                            );
                        }
                    }
                }
            }
        }
    }
    Image::new_owned(rgba, w as u32, h as u32)
}

/// 3×5 点阵数字。
fn glyph(ch: char) -> [u8; 5] {
    match ch {
        '0' => [0b111, 0b101, 0b101, 0b101, 0b111],
        '1' => [0b010, 0b110, 0b010, 0b010, 0b111],
        '2' => [0b111, 0b001, 0b111, 0b100, 0b111],
        '3' => [0b111, 0b001, 0b111, 0b001, 0b111],
        '4' => [0b101, 0b101, 0b111, 0b001, 0b001],
        '5' => [0b111, 0b100, 0b111, 0b001, 0b111],
        '6' => [0b111, 0b100, 0b111, 0b101, 0b111],
        '7' => [0b111, 0b001, 0b010, 0b010, 0b010],
        '8' => [0b111, 0b101, 0b111, 0b101, 0b111],
        '9' => [0b111, 0b101, 0b111, 0b001, 0b111],
        '+' => [0b000, 0b010, 0b111, 0b010, 0b000],
        _ => [0; 5],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn badge_draws_only_when_there_are_new_images() {
        let icon = Image::new_owned(vec![0; 32 * 32 * 4], 32, 32);
        assert_eq!(badge(&icon, 0).rgba(), icon.rgba());
        let drawn = badge(&icon, 12);
        // 右上角是红点，左下角不动。
        let at = |x: usize, y: usize| &drawn.rgba()[(y * 32 + x) * 4..(y * 32 + x) * 4 + 4];
        assert_eq!(at(31 - 9, 1)[3], 0xFF);
        assert_eq!(at(0, 31), [0, 0, 0, 0]);
    }
}
