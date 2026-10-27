use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU32, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

use common::api_bindings::AdminActiveStream;
use tokio::sync::watch;

/// Keeps track of every running streamer so the admin can list and stop them
#[derive(Default)]
pub struct StreamRegistry {
    next_id: AtomicU32,
    streams: Mutex<HashMap<u32, RegisteredStream>>,
}

struct RegisteredStream {
    info: ActiveStreamInfo,
    started: SystemTime,
    stop: watch::Sender<bool>,
}

pub struct ActiveStreamInfo {
    pub user_name: String,
    pub host_id: u32,
    pub host_name: String,
    pub app_name: String,
}

impl StreamRegistry {
    /// The stream stays listed until the returned guard is dropped.
    /// The receiver turns true when the admin wants the stream stopped.
    pub fn register(
        self: &Arc<Self>,
        info: ActiveStreamInfo,
    ) -> (StreamGuard, watch::Receiver<bool>) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (stop, stop_receiver) = watch::channel(false);

        self.lock().insert(
            id,
            RegisteredStream {
                info,
                started: SystemTime::now(),
                stop,
            },
        );

        (
            StreamGuard {
                registry: self.clone(),
                id,
            },
            stop_receiver,
        )
    }

    pub fn list(&self) -> Vec<AdminActiveStream> {
        let mut streams = self
            .lock()
            .iter()
            .map(|(id, stream)| AdminActiveStream {
                stream_id: *id,
                user_name: stream.info.user_name.clone(),
                host_id: stream.info.host_id,
                host_name: stream.info.host_name.clone(),
                app_name: stream.info.app_name.clone(),
                started_unix_secs: stream
                    .started
                    .duration_since(UNIX_EPOCH)
                    .map(|duration| duration.as_secs())
                    .unwrap_or(0),
            })
            .collect::<Vec<_>>();

        streams.sort_by_key(|stream| stream.stream_id);
        streams
    }

    /// Signals every stream to stop, returns how many were signaled
    pub fn stop_all(&self) -> u32 {
        let streams = self.lock();

        for stream in streams.values() {
            stream.stop.send_replace(true);
        }

        streams.len() as u32
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<u32, RegisteredStream>> {
        // a panic while holding the lock can't leave the map in a broken state
        self.streams
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

pub struct StreamGuard {
    registry: Arc<StreamRegistry>,
    id: u32,
}

impl Drop for StreamGuard {
    fn drop(&mut self) {
        self.registry.lock().remove(&self.id);
    }
}
