pub struct AppState {
    port: u16,
}

impl AppState {
    pub fn new(port: u16) -> Self {
        Self { port }
    }

    pub fn server_port(&self) -> u16 {
        self.port
    }
}
