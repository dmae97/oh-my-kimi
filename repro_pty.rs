use portable_pty::{native_pty_system, PtySize, CommandBuilder};

fn main() {
    println!("Starting PTY reproduction...");
    let pty_system = native_pty_system();
    println!("Got pty system");

    let pair = pty_system.openpty(PtySize {
        rows: 40,
        cols: 120,
        pixel_width: 0,
        pixel_height: 0,
    });
    match pair {
        Ok(p) => println!("openpty succeeded!"),
        Err(e) => println!("openpty failed: {}", e),
    }

    println!("Done.");
}
