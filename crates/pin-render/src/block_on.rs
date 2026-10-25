use std::future::Future;
use std::task::{Context, Poll, Waker};

/// 在当前线程上等一个 future。wgpu 在原生平台上请求适配器、设备与弹出错误作用域的 future
/// 都是立即就绪的，用不着异步运行时。
pub(crate) fn block_on<F: Future>(future: F) -> F::Output {
    let mut future = std::pin::pin!(future);
    let mut cx = Context::from_waker(Waker::noop());
    loop {
        if let Poll::Ready(value) = future.as_mut().poll(&mut cx) {
            return value;
        }
        std::thread::yield_now();
    }
}
