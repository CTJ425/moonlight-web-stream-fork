use std::{
    ops::Deref,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use tokio::{spawn, sync::mpsc::Sender, time::sleep};
use tracing::{debug, warn};

use crate::app::{
    App, AppError,
    host::Host,
    user::{Admin, AuthenticatedUser, RoleType, User},
};

pub enum ExternalStreamEvent {
    WebRTCAddIceCandidate { ice_sdp_frag: String },
    Stop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct StreamId(pub u32);

/// Shown in the admin monitor
#[derive(Debug, Clone)]
pub struct StreamInfo {
    pub user_name: String,
    pub host_id: u32,
    pub host_name: String,
    pub app_name: String,
    pub started_unix_secs: u64,
}

/// Names for the admin stream list, a lookup failure must not prevent the stream
pub async fn admin_names(user: &mut AuthenticatedUser, host: &Host) -> (String, String) {
    let user_name = match user.detailed_user().await {
        Ok(detailed) => detailed.name,
        Err(_) => user.id().to_string(),
    };
    let host_name = match host.undetailed_host_cached(user).await {
        Ok(undetailed) => undetailed.name,
        Err(_) => host.id().0.to_string(),
    };

    (user_name, host_name)
}

impl StreamInfo {
    pub fn new(user_name: String, host_id: u32, host_name: String, app_name: String) -> Self {
        Self {
            user_name,
            host_id,
            host_name,
            app_name,
            started_unix_secs: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_secs())
                .unwrap_or(0),
        }
    }
}

#[derive(Clone)]
pub struct Stream {
    inner: Arc<StreamInner>,
}

impl Stream {
    pub async fn new(
        app: &App,
        owner: &AuthenticatedUser,
        event_sender: Sender<ExternalStreamEvent>,
        info: StreamInfo,
    ) -> Result<Self, AppError> {
        app.insert_stream(|id| {
            let app_ref = app.new_ref();

            spawn({
                let event_sender = event_sender.clone();

                async move {
                loop {
                    sleep(Duration::from_secs(30)).await;

                    {
                        let app = match app_ref.access() {
                            Ok(value) => value,
                            Err(err) => {
                                warn!(stream_id = ?id, error = %err, "failed to aquire app in alive check for stream");
                                return;
                            }
                        };

                        if event_sender.is_closed() {
                            debug!("identified stream as closed, waiting some time and then removing it");
                            sleep(Duration::from_secs(10)).await;

                            let mut streams = app.streams.write().await;
                            streams.remove(&id);

                            debug!(stream_id = ?id, "removed stopped stream from app");
                            return;
                        }
                    }
                }
            }});

            Self {
                inner: Arc::new(StreamInner {
                    id,
                    owner: owner.deref().clone(),
                    event_sender,
                    info,
                }),
            }
        })
        .await
    }

    pub fn id(&self) -> StreamId {
        self.inner.id
    }

    pub async fn owner(&self) -> Result<User, AppError> {
        Ok(self.inner.owner.clone())
    }

    async fn has_permissions(&self, user: &mut AuthenticatedUser) -> Result<(), AppError> {
        if matches!(user.role().await?.ty().await?, RoleType::Admin)
            || user.id() == self.owner().await?.id()
        {
            Ok(())
        } else {
            Err(AppError::Forbidden)
        }
    }

    pub async fn send_event(
        &self,
        user: &mut AuthenticatedUser,
        event: ExternalStreamEvent,
    ) -> Result<(), AppError> {
        self.has_permissions(user).await?;

        self.inner
            .event_sender
            .send(event)
            .await
            .map_err(|_| AppError::StreamClosed)?;

        Ok(())
    }

    pub fn is_alive(&self) -> Result<bool, AppError> {
        Ok(!self.inner.event_sender.is_closed())
    }

    pub fn info(&self) -> &StreamInfo {
        &self.inner.info
    }

    /// Stop without a permission check, only for the admin
    pub async fn stop_as_admin(&self, _admin: &Admin) -> Result<(), AppError> {
        self.inner
            .event_sender
            .send(ExternalStreamEvent::Stop)
            .await
            .map_err(|_| AppError::StreamClosed)
    }
}

pub(crate) struct StreamInner {
    pub(crate) id: StreamId,
    pub(crate) owner: User,
    pub(crate) event_sender: Sender<ExternalStreamEvent>,
    pub(crate) info: StreamInfo,
}
