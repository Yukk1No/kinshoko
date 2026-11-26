use std::sync::{Arc, Mutex};

use super::{Error, Inner, LibraryEvent};

impl Inner {
    /// 在写线程上跑一个短事务；提交后才推送“列表过期”。
    pub(crate) fn write<T: Send + 'static>(
        &self,
        f: impl FnOnce(&rusqlite::Transaction) -> Result<T, Error> + Send + 'static,
    ) -> Result<T, Error> {
        self.write_holding(Arc::new(Mutex::new(())), move |tx, _| f(tx))
    }

    /// 与 [`Inner::write`] 相同，但从核对到提交一直持有 `lock`：拿这把锁核对后再登记的一方
    /// （例如导入登记保存文件夹）要么在这次写入之前，要么只看得到已提交的结果，不会夹在中间。
    pub(crate) fn write_holding<T: Send + 'static, G: Send + 'static>(
        &self,
        lock: Arc<Mutex<G>>,
        f: impl FnOnce(&rusqlite::Transaction, &mut G) -> Result<T, Error> + Send + 'static,
    ) -> Result<T, Error> {
        let result = self.writer.run(move |conn| {
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let mut held = lock.lock().unwrap_or_else(|e| e.into_inner());
            let value = f(&tx, &mut held)?;
            tx.commit()?;
            drop(held);
            Ok(value)
        });
        if result.is_ok() {
            self.hub.publish(LibraryEvent::ListStale {
                library_id: self.info.id.clone(),
            });
        }
        result
    }
}
