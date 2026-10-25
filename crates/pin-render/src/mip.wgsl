// 生成下一层 mip：第 L+1 层纹素 j 是第 L 层纹素 2j、2j+1（两个方向）的平均。
// 源图是线性光、预乘 alpha，直接平均就是正确的盒式缩小。奇数边长时最后一列（行）不进下一层，
// 这样第 L 层纹素 j 正好盖住第 0 层的 [j·2^L, (j+1)·2^L)，着色器按这个关系夹裁切。
@group(0) @binding(0) var src: texture_2d<f32>;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
    return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
    let size = vec2<i32>(textureDimensions(src));
    let a = vec2<i32>(frag.xy) * 2;
    let b = min(a + 1, size - 1);
    return 0.25 * (textureLoad(src, a, 0) + textureLoad(src, vec2<i32>(b.x, a.y), 0)
        + textureLoad(src, vec2<i32>(a.x, b.y), 0) + textureLoad(src, b, 0));
}
