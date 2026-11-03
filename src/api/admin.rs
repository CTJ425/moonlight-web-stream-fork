use std::time::Duration;

use actix_web::{
    get, post,
    web::{Data, Json},
};
use crate::api::bindings::{
    AdminActiveStream, AdminHostMonitor, AdminTerminateHostResult, AgentStats,
    GetAdminMonitorResponse, PairStatus, PostAdminTerminateAllResponse,
};
use futures::future::{join_all, try_join_all};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    time::{Instant, sleep, timeout},
};
use tracing::{info, warn};

use crate::app::{App, AppError, user::AuthenticatedUser};

const AGENT_TIMEOUT: Duration = Duration::from_secs(2);
const AGENT_MAX_RESPONSE: u64 = 1024 * 1024;
const CANCEL_TIMEOUT: Duration = Duration::from_secs(10);
const STREAMS_STOP_TIMEOUT: Duration = Duration::from_secs(5);
/// Time for a stopped stream to send the moonlight disconnect to the host
const STREAMS_DISCONNECT_GRACE: Duration = Duration::from_secs(1);

#[get("/admin/monitor")]
pub async fn get_monitor(
    app: Data<App>,
    mut user: AuthenticatedUser,
) -> Result<Json<GetAdminMonitorResponse>, AppError> {
    user.clone().into_admin().await?;

    let agent = &app.config().host_agent;

    let hosts = user.hosts().await?;
    let hosts = try_join_all(hosts.into_iter().map(|host| {
        let mut user = user.clone();

        async move {
            let undetailed = host.undetailed_host_cached(&mut user).await?;
            let address = host.address(&mut user).await?;

            let (stats, agent_error) = match &agent.token {
                None => (None, None),
                Some(token) => match fetch_agent_stats(&address, agent.port, token).await {
                    Ok(stats) => (Some(stats), None),
                    Err(err) => (None, Some(err)),
                },
            };

            Ok::<_, AppError>(AdminHostMonitor {
                host_id: undetailed.host_id,
                name: undetailed.name,
                address,
                paired: undetailed.paired,
                agent: stats,
                agent_error,
            })
        }
    }))
    .await?;

    Ok(Json(GetAdminMonitorResponse {
        agent_enabled: agent.token.is_some(),
        hosts,
        streams: app
            .alive_streams()
            .await
            .into_iter()
            .map(|stream| {
                let info = stream.info();

                AdminActiveStream {
                    stream_id: stream.id().0,
                    user_name: info.user_name.clone(),
                    host_id: info.host_id,
                    host_name: info.host_name.clone(),
                    app_name: info.app_name.clone(),
                    started_unix_secs: info.started_unix_secs,
                }
            })
            .collect(),
    }))
}

/// Stops every stream of this web server and cancels the running app on every paired host,
/// which also ends sessions of other Moonlight clients on that host.
/// Hosts are the ones this admin can list (own and global), same as the monitor, so the agent
/// token is never sent to an address another user added.
#[post("/admin/terminate_all")]
pub async fn post_terminate_all(
    app: Data<App>,
    mut user: AuthenticatedUser,
) -> Result<Json<PostAdminTerminateAllResponse>, AppError> {
    let admin = user.clone().into_admin().await?;

    let streams = app.alive_streams().await;
    let mut streams_stopped = 0;
    for stream in &streams {
        if stream.stop_as_admin(&admin).await.is_ok() {
            streams_stopped += 1;
        }
    }

    // Let the streams end first so the host sees the disconnect before the cancel
    let deadline = Instant::now() + STREAMS_STOP_TIMEOUT;
    while streams
        .iter()
        .any(|stream| stream.is_alive().unwrap_or(false))
        && Instant::now() < deadline
    {
        sleep(Duration::from_millis(100)).await;
    }
    if streams_stopped > 0 {
        sleep(STREAMS_DISCONNECT_GRACE).await;
    }

    let hosts = user.hosts().await?;
    let results = join_all(hosts.into_iter().map(|mut host| {
        let mut user = user.clone();

        async move {
            let undetailed = match host.undetailed_host_cached(&mut user).await {
                Ok(value) => value,
                Err(err) => {
                    return Some(AdminTerminateHostResult {
                        host_id: host.id().0,
                        name: String::new(),
                        success: false,
                        error: Some(err.to_string()),
                    });
                }
            };

            if !matches!(undetailed.paired, PairStatus::Paired) {
                return None;
            }

            let error = match timeout(CANCEL_TIMEOUT, host.cancel_app(&mut user)).await {
                Ok(Ok(true)) => None,
                Ok(Ok(false)) => Some("the host refused to cancel".to_string()),
                Ok(Err(err)) => Some(err.to_string()),
                Err(_) => Some("timed out".to_string()),
            };

            Some(AdminTerminateHostResult {
                host_id: undetailed.host_id,
                name: undetailed.name,
                success: error.is_none(),
                error,
            })
        }
    }))
    .await
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();

    info!(
        "terminated all sessions, {streams_stopped} streams stopped, hosts: {:?}",
        results
            .iter()
            .map(|result| (&result.name, result.success))
            .collect::<Vec<_>>()
    );

    Ok(Json(PostAdminTerminateAllResponse {
        streams_stopped,
        hosts: results,
    }))
}

/// Plain HTTP/1.0 GET against the agent, it closes the connection after the response
async fn fetch_agent_stats(address: &str, port: u16, token: &str) -> Result<AgentStats, String> {
    // the address ends up in the request head
    if address.chars().any(char::is_control) {
        return Err("invalid host address".to_string());
    }
    let host_header = if address.contains(':') {
        format!("[{address}]:{port}")
    } else {
        format!("{address}:{port}")
    };

    let request = async {
        let mut stream = TcpStream::connect((address, port))
            .await
            .map_err(|err| format!("connect failed: {err}"))?;

        let request = format!(
            "GET /stats HTTP/1.0\r\nHost: {host_header}\r\nAuthorization: Bearer {token}\r\n\r\n"
        );
        stream
            .write_all(request.as_bytes())
            .await
            .map_err(|err| format!("send failed: {err}"))?;

        let mut response = Vec::new();
        stream
            .take(AGENT_MAX_RESPONSE)
            .read_to_end(&mut response)
            .await
            .map_err(|err| format!("receive failed: {err}"))?;

        Ok::<_, String>(response)
    };

    let response = timeout(AGENT_TIMEOUT, request)
        .await
        .map_err(|_| "timed out".to_string())??;

    let response = String::from_utf8_lossy(&response);
    let Some((head, body)) = response.split_once("\r\n\r\n") else {
        return Err("malformed response".to_string());
    };

    let status = head.split_whitespace().nth(1).unwrap_or("");
    if status != "200" {
        return Err(format!("agent returned status {status}"));
    }

    serde_json::from_str(body).map_err(|err| {
        warn!("invalid agent response from {address}: {err}");
        format!("invalid response: {err}")
    })
}
