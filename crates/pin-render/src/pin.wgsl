// 钉图：整个窗口一个三角形，按屏幕坐标算每个像素落在内容、阴影还是外面。
//
// 源图是线性工作空间、预乘 alpha 的 Rgba16Float，全部用 textureLoad 手工采样（不用采样器）：
// 只读裁切范围里完整的纹素，局部以外的像素不会混进来。钉图颜色与界面颜色（遮蔽墨色、细线、说明层）
// 各自查表转到显示器编码，再在显示器编码下合成，按预乘 alpha 输出。各字段见 uniform.rs 的 PinUniform。

struct Pin {
    content: vec4<f32>,
    crop: vec4<f32>,
    overlay: vec4<f32>,
    ink: vec4<f32>,
    ring: vec4<f32>,
    appear: vec4<f32>,
    misc: vec4<f32>,
    shape: vec4<f32>,
    flags: vec4<u32>,
};

@group(0) @binding(0) var<uniform> pin: Pin;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var lut: texture_3d<f32>;
@group(0) @binding(3) var curve: texture_2d<f32>;
@group(0) @binding(4) var overlay: texture_2d<f32>;
@group(0) @binding(5) var ui_lut: texture_3d<f32>;
@group(0) @binding(6) var ui_curve: texture_2d<f32>;

// 与 lib.rs 的 LUT_SIZE、LUT_DOMAIN、CURVE_SIZE 相同。
const LUT_N: i32 = 65;
const LUT_LO: f32 = -1.5;
const LUT_HI: f32 = 2.5;
const CURVE_N: i32 = 4096;

const MODE_EXACT: u32 = 0u;
const MODE_MINIFY: u32 = 1u;
const LUT_IDENTITY: u32 = 1u;
const LUT_LINEAR: u32 = 4u;
const BLUR: u32 = 2u;
// 界面颜色那张表的标志在 flags.w 里左移这么多位。
const UI_SHIFT: u32 = 3u;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
    return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}

// ---- 源图采样 -------------------------------------------------------------------------------

// 第 level 层里完整落在裁切范围内的纹素：lo.xy, hi.xy（含）。
fn level_range(level: u32) -> vec4<i32> {
    let s = f32(1u << level);
    let size = vec2<i32>(textureDimensions(src, level));
    let lo = vec2<i32>(ceil(pin.crop.xy / s));
    let hi = min(vec2<i32>(floor(pin.crop.zw / s)) - 1, size - 1);
    return vec4<i32>(lo, max(hi, lo));
}

fn texel(c: vec2<i32>, level: u32) -> vec4<f32> {
    return textureLoad(src, c, level);
}

// 第 0 层纹素坐标 p 处，第 level 层的双线性（越过裁切边的取边上的纹素）。
fn bilinear(p: vec2<f32>, level: u32) -> vec4<f32> {
    let r = level_range(level);
    let q = clamp(p / f32(1u << level) - 0.5, vec2<f32>(r.xy), vec2<f32>(r.zw));
    let i0 = vec2<i32>(floor(q));
    let f = q - vec2<f32>(i0);
    let i1 = min(i0 + 1, r.zw);
    let a = mix(texel(i0, level), texel(vec2<i32>(i1.x, i0.y), level), f.x);
    let b = mix(texel(vec2<i32>(i0.x, i1.y), level), texel(i1, level), f.x);
    return mix(a, b, f.y);
}

fn trilinear(p: vec2<f32>, lod: f32) -> vec4<f32> {
    let top = pin.flags.z;
    let l = clamp(lod, 0.0, f32(top));
    let l0 = u32(floor(l));
    let f = l - f32(l0);
    let a = bilinear(p, l0);
    if (f <= 0.0 || l0 >= top) {
        return a;
    }
    return mix(a, bilinear(p, l0 + 1u), f);
}

fn exact(p: vec2<f32>) -> vec4<f32> {
    let r = level_range(0u);
    return texel(clamp(vec2<i32>(floor(p)), r.xy, r.zw), 0u);
}

// Catmull-Rom 在 t 处对 -1、0、1、2 四个纹素的权重。
fn catmull_rom(t: f32) -> vec4<f32> {
    let t2 = t * t;
    let t3 = t2 * t;
    return vec4<f32>(
        0.5 * (-t3 + 2.0 * t2 - t),
        0.5 * (3.0 * t3 - 5.0 * t2 + 2.0),
        0.5 * (-3.0 * t3 + 4.0 * t2 + t),
        0.5 * (t3 - t2),
    );
}

fn bicubic(p: vec2<f32>) -> vec4<f32> {
    let r = level_range(0u);
    let q = p - 0.5;
    let base = vec2<i32>(floor(q));
    let f = q - floor(q);
    var wx = array<f32, 4>();
    var wy = array<f32, 4>();
    let cx = catmull_rom(f.x);
    let cy = catmull_rom(f.y);
    wx[0] = cx.x; wx[1] = cx.y; wx[2] = cx.z; wx[3] = cx.w;
    wy[0] = cy.x; wy[1] = cy.y; wy[2] = cy.z; wy[3] = cy.w;
    var sum = vec4<f32>(0.0);
    for (var y = 0; y < 4; y++) {
        var row = vec4<f32>(0.0);
        for (var x = 0; x < 4; x++) {
            let c = clamp(base + vec2<i32>(x - 1, y - 1), r.xy, r.zw);
            row += wx[x] * texel(c, 0u);
        }
        sum += wy[y] * row;
    }
    return sum;
}

// 遮蔽的高斯模糊：在标准差不超过约 1.5 个纹素的那一层上取 7×7 个点。
fn blurred(p: vec2<f32>) -> vec4<f32> {
    let sigma0 = pin.shape.z;
    let level = u32(clamp(ceil(log2(sigma0 / 1.5)), 0.0, f32(pin.flags.z)));
    let scale = f32(1u << level);
    let sigma = sigma0 / scale;
    // 层数到顶时标准差可能还大：拉开取样间距，仍用 7×7。
    let spread = max(1.0, sigma / 1.5);
    var sum = vec4<f32>(0.0);
    var total = 0.0;
    for (var y = -3; y <= 3; y++) {
        for (var x = -3; x <= 3; x++) {
            let d = vec2<f32>(f32(x), f32(y)) * spread;
            let w = exp(-dot(d, d) / (2.0 * sigma * sigma));
            sum += w * bilinear(p + d * scale, level);
            total += w;
        }
    }
    return sum / total;
}

// ---- 颜色 -----------------------------------------------------------------------------------

fn oetf(l: vec3<f32>) -> vec3<f32> {
    let a = abs(l);
    let lo = a * 12.92;
    let hi = 1.055 * pow(a, vec3<f32>(1.0 / 2.4)) - 0.055;
    return sign(l) * select(hi, lo, a <= vec3<f32>(0.0031308));
}

fn eotf(e: vec3<f32>) -> vec3<f32> {
    let a = abs(e);
    let lo = a / 12.92;
    let hi = pow((a + 0.055) / 1.055, vec3<f32>(2.4));
    return sign(e) * select(hi, lo, a <= vec3<f32>(0.04045));
}

// 源空间编码值 → 显示器编码值（查找表的约定见 kinshoko-core 的 desktop::pin_colour）。
// `bits` 是这张表的 LUT_IDENTITY／LUT_LINEAR。
fn display(e: vec3<f32>, table: texture_3d<f32>, crv: texture_2d<f32>, bits: u32) -> vec3<f32> {
    if ((bits & LUT_IDENTITY) != 0u) {
        return clamp(e, vec3<f32>(0.0), vec3<f32>(1.0));
    }
    let n = f32(LUT_N - 1);
    var x = e;
    var lo = LUT_LO;
    var hi = LUT_HI;
    if ((bits & LUT_LINEAR) != 0u) {
        // 矩阵型显示器：表是线性值的线性函数，按线性值查，三线性插值精确。
        x = eotf(e);
        lo = eotf(vec3<f32>(LUT_LO)).x;
        hi = eotf(vec3<f32>(LUT_HI)).x;
    }
    let g = clamp((x - lo) / (hi - lo) * n, vec3<f32>(0.0), vec3<f32>(n));
    let i = min(vec3<i32>(floor(g)), vec3<i32>(LUT_N - 2));
    let f = g - vec3<f32>(i);
    let x00 = mix(textureLoad(table, i, 0).rgb, textureLoad(table, i + vec3<i32>(1, 0, 0), 0).rgb, f.x);
    let x10 = mix(textureLoad(table, i + vec3<i32>(0, 1, 0), 0).rgb, textureLoad(table, i + vec3<i32>(1, 1, 0), 0).rgb, f.x);
    let x01 = mix(textureLoad(table, i + vec3<i32>(0, 0, 1), 0).rgb, textureLoad(table, i + vec3<i32>(1, 0, 1), 0).rgb, f.x);
    let x11 = mix(textureLoad(table, i + vec3<i32>(0, 1, 1), 0).rgb, textureLoad(table, i + vec3<i32>(1, 1, 1), 0).rgb, f.x);
    let y = mix(mix(x00, x10, f.y), mix(x01, x11, f.y), f.z);

    let t = oetf(clamp(y, vec3<f32>(0.0), vec3<f32>(1.0))) * f32(CURVE_N - 1);
    let j = min(vec3<i32>(floor(t)), vec3<i32>(CURVE_N - 2));
    let h = t - vec3<f32>(j);
    return vec3<f32>(
        mix(textureLoad(crv, vec2<i32>(j.x, 0), 0).r, textureLoad(crv, vec2<i32>(j.x + 1, 0), 0).r, h.x),
        mix(textureLoad(crv, vec2<i32>(j.y, 0), 0).g, textureLoad(crv, vec2<i32>(j.y + 1, 0), 0).g, h.y),
        mix(textureLoad(crv, vec2<i32>(j.z, 0), 0).b, textureLoad(crv, vec2<i32>(j.z + 1, 0), 0).b, h.z),
    );
}

// 预乘、源空间编码的钉图颜色 → 预乘的显示器编码。
fn shown(c: vec4<f32>) -> vec4<f32> {
    if (c.a <= 0.0) {
        return vec4<f32>(0.0);
    }
    return vec4<f32>(display(c.rgb / c.a, lut, curve, pin.flags.w) * c.a, c.a);
}

// 预乘、sRGB 编码的界面颜色（遮蔽墨色、细线、说明层）→ 预乘的显示器编码。截图钉图的源空间是
// 截图时那台显示器，界面颜色另走工作空间到显示器的表（`Draw::ui_lut`）。
fn ui(c: vec4<f32>) -> vec4<f32> {
    if (c.a <= 0.0) {
        return vec4<f32>(0.0);
    }
    return vec4<f32>(display(c.rgb / c.a, ui_lut, ui_curve, pin.flags.w >> UI_SHIFT) * c.a, c.a);
}

// 预乘颜色的“源在上”合成。
fn over(top: vec4<f32>, bottom: vec4<f32>) -> vec4<f32> {
    return top + bottom * (1.0 - top.a);
}

fn erf(x: f32) -> f32 {
    // Abramowitz–Stegun 7.1.26，误差 < 1.5e-7。
    let a = abs(x);
    let t = 1.0 / (1.0 + 0.3275911 * a);
    let y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-a * a);
    return sign(x) * y;
}

// CSS box-shadow 的高斯：矩形 [lo, hi) 模糊后在 s 处的覆盖率。
fn cover(s: vec2<f32>, lo: vec2<f32>, hi: vec2<f32>, sigma: f32) -> f32 {
    let k = 1.0 / (sqrt(2.0) * sigma);
    let x = 0.5 * (erf((hi.x - s.x) * k) - erf((lo.x - s.x) * k));
    let y = 0.5 * (erf((hi.y - s.y) * k) - erf((lo.y - s.y) * k));
    return x * y;
}

// ---- 一个像素 -------------------------------------------------------------------------------

@fragment
fn fs(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
    let s = frag.xy + pin.misc.xy;
    let c0 = pin.content.xy;
    let c1 = pin.content.xy + pin.content.zw;
    let edge = pin.shape.x;

    // 预乘、显示器编码下的颜色：钉图与界面颜色各自查表后合成。
    var colour = vec4<f32>(0.0);
    if (all(s >= c0) && all(s < c1)) {
        // 屏幕 → 源图：先撤旋转，再撤翻转（画的时候先翻转、再旋转）。
        let u = (s - c0) / pin.content.zw;
        var t = u;
        switch (pin.flags.x & 3u) {
            case 1u: { t = vec2<f32>(u.y, 1.0 - u.x); }
            case 2u: { t = 1.0 - u; }
            case 3u: { t = vec2<f32>(1.0 - u.y, u.x); }
            default: {}
        }
        if ((pin.flags.x & 4u) != 0u) { t.x = 1.0 - t.x; }
        if ((pin.flags.x & 8u) != 0u) { t.y = 1.0 - t.y; }
        let p = mix(pin.crop.xy, pin.crop.zw, t);

        var lin: vec4<f32>;
        if ((pin.flags.w & BLUR) != 0u) {
            lin = blurred(p);
        } else if (pin.flags.y == MODE_EXACT) {
            lin = exact(p);
        } else if (pin.flags.y == MODE_MINIFY) {
            lin = trilinear(p, pin.misc.w);
        } else {
            lin = bicubic(p);
        }
        let a = clamp(lin.a, 0.0, 1.0);
        if (a > 0.0) {
            colour = shown(vec4<f32>(oetf(lin.rgb / lin.a) * a, a));
        }
        // 出现提示框（pin-appear 的 inset 描边）：在图上、遮蔽墨色之下。
        let aw = pin.shape.w;
        if (aw > 0.0 && (any(s < c0 + aw) || any(s >= c1 - aw))) {
            colour = over(ui(pin.appear), colour);
        }
        colour = over(ui(pin.ink), colour);
    } else {
        // pin-edge.css：0 0.25e 0.625e 近处投影与 0 0 0.375e 贴身暗边（CSS 模糊半径的一半是标准差）；
        // 只画在内容外面。增强边缘的细线在最上面，与阴影无关。
        if (edge > 0.0) {
            let drop = vec2<f32>(0.0, 0.25 * edge);
            let a1 = 0.30 * cover(s, c0 + drop, c1 + drop, 0.3125 * edge);
            let a2 = 0.28 * cover(s, c0, c1, 0.1875 * edge);
            colour = vec4<f32>(0.0, 0.0, 0.0, 1.0 - (1.0 - a1) * (1.0 - a2));
        }
        let w = pin.shape.y;
        if (w > 0.0 && all(s >= c0 - w) && all(s < c1 + w)) {
            colour = over(ui(pin.ring), colour);
        }
    }

    if (pin.overlay.z > 0.0) {
        let o = s - pin.overlay.xy;
        if (all(o >= vec2<f32>(0.0)) && all(o < pin.overlay.zw)) {
            colour = over(ui(textureLoad(overlay, vec2<i32>(floor(o)), 0)), colour);
        }
    }

    var out = colour * pin.misc.z;
    // 阴影那一圈算钉图的一部分：最淡处也留 1/255，窗口按 alpha 命中时按得到。内容里不动，透明的源像素
    // 仍然透明。
    let inside = all(s >= c0) && all(s < c1);
    if (edge > 0.0 && !inside && all(s >= c0 - edge) && all(s < c1 + edge)) {
        out.a = max(out.a, 1.0 / 255.0);
    }
    return out;
}
