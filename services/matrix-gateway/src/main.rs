use std::{
    ffi::OsString,
    io::{self, Write},
    process::ExitCode,
};

fn main() -> ExitCode {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    if args.is_empty() {
        eprintln!("gateway configuration not implemented");
        return ExitCode::from(78);
    }

    match communicator_matrix_gateway::admin::run(&args) {
        Ok(result) => {
            if io::stdout()
                .write_all(format!("{result}\n").as_bytes())
                .is_err()
            {
                return ExitCode::from(74);
            }
            ExitCode::SUCCESS
        }
        Err(error) => {
            let _ = io::stderr().write_all(format!("{}\n", error.code()).as_bytes());
            ExitCode::from(78)
        }
    }
}
