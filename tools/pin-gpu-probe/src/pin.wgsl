// 钉图：整窗口一个三角形，按屏幕坐标算这一像素落在内容里还是阴影里。
// 缩放、旋转翻转、透明度、阴影都在这里；采样在线性光下（sRGB 纹理），输出按 sRGB 编码后预乘。

struct Pin {
    // 窗口左上角（屏幕物理像素）。
    origin: vec2<f32>,
    // 1 = 顺时针转 1/4 圈……；bit 2 = 左右翻转，bit 3 = 上下翻转。
    turn: u32,
    opacity: f32,
    // 内容矩形（屏幕物理像素）x, y, w, h。
    content: vec4<f32>,
    // 源图里要显示的部分（裁切），uv：x0, y0, x1, y1。
    crop: vec4<f32>,
};

@group(0) @binding(0) var<uniform> pin: Pin;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var smp: sampler;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
    return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}

fn erf(x: f32) -> f32 {
    // Abramowitz–Stegun 7.1.26，误差 < 1.5e-7。
    let s = sign(x);
    let a = abs(x);
    let t = 1.0 / (1.0 + 0.3275911 * a);
    let y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-a * a);
    return s * y;
}

// CSS box-shadow 的高斯：矩形 [lo, hi] 在点 p 处的覆盖。
fn cover(p: vec2<f32>, lo: vec2<f32>, hi: vec2<f32>, sigma: f32) -> f32 {
    let k = 1.0 / (sqrt(2.0) * sigma);
    let x = 0.5 * (erf((hi.x - p.x) * k) - erf((lo.x - p.x) * k));
    let y = 0.5 * (erf((hi.y - p.y) * k) - erf((lo.y - p.y) * k));
    return x * y;
}

fn encode(c: vec3<f32>) -> vec3<f32> {
    let lo = c * 12.92;
    let hi = 1.055 * pow(c, vec3<f32>(1.0 / 2.4)) - 0.055;
    return select(hi, lo, c <= vec3<f32>(0.0031308));
}

@fragment
fn fs(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
    let s = frag.xy + pin.origin;
    let c0 = pin.content.xy;
    let c1 = pin.content.xy + pin.content.zw;

    // 显示坐标 → 源图坐标：先撤翻转，再撤旋转。
    var u = (s - c0) / pin.content.zw;
    if ((pin.turn & 4u) != 0u) { u.x = 1.0 - u.x; }
    if ((pin.turn & 8u) != 0u) { u.y = 1.0 - u.y; }
    var t = u;
    switch (pin.turn & 3u) {
        case 1u: { t = vec2<f32>(u.y, 1.0 - u.x); }
        case 2u: { t = vec2<f32>(1.0 - u.x, 1.0 - u.y); }
        case 3u: { t = vec2<f32>(1.0 - u.y, u.x); }
        default: {}
    }
    let uv = mix(pin.crop.xy, pin.crop.zw, t);
    // 在一致的控制流里采样（导数要对），再按是否在内容里取舍。
    let texel = textureSample(src, smp, uv);

    // pin-edge.css：0 2px 5px rgba(0,0,0,.3) 与 0 0 3px rgba(0,0,0,.28)。
    let a1 = 0.30 * cover(s, c0 + vec2<f32>(0.0, 2.0), c1 + vec2<f32>(0.0, 2.0), 2.5);
    let a2 = 0.28 * cover(s, c0, c1, 1.5);
    let shadow = 1.0 - (1.0 - a1) * (1.0 - a2);

    let inside = all(s >= c0) && all(s < c1);
    var out = vec4<f32>(0.0, 0.0, 0.0, shadow);
    if (inside) {
        let a = texel.a;
        out = vec4<f32>(encode(texel.rgb) * a, a + shadow * (1.0 - a));
    }
    return out * pin.opacity;
}
