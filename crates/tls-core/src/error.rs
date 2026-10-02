use serde::Serialize;

/// Все ошибки движка. Тексты — для пользователя (русский), код — для логики UI.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Не найден ffmpeg/ffprobe: {0}")]
    ToolMissing(String),
    #[error("Файл не читается: {path} ({reason})")]
    Unreadable { path: String, reason: String },
    #[error("Нет ни одного читаемого клипа для сборки")]
    NoClips,
    #[error("Не выбран ни один формат для экспорта")]
    NoTargets,
    #[error("Недостаточно места на диске: нужно ~{need_mb} МБ, свободно {free_mb} МБ")]
    DiskSpace { need_mb: u64, free_mb: u64 },
    #[error("Сборка отменена")]
    Cancelled,
    #[error("{summary}")]
    Ffmpeg { summary: String, log: Vec<String> },
    #[error("Операция не уложилась в отведённое время: {0}")]
    Timeout(String),
    #[error("Некорректные данные: {0}")]
    Invalid(String),
    #[error("Ошибка файловой системы: {0}")]
    Io(#[from] std::io::Error),
    #[error("Ошибка формата данных: {0}")]
    Json(#[from] serde_json::Error),
}

impl Error {
    pub fn code(&self) -> &'static str {
        match self {
            Error::ToolMissing(_) => "tool_missing",
            Error::Unreadable { .. } => "unreadable",
            Error::NoClips => "no_clips",
            Error::NoTargets => "no_targets",
            Error::DiskSpace { .. } => "disk_space",
            Error::Cancelled => "cancelled",
            Error::Ffmpeg { .. } => "ffmpeg",
            Error::Timeout(_) => "timeout",
            Error::Invalid(_) => "invalid",
            Error::Io(_) => "io",
            Error::Json(_) => "json",
        }
    }
}

impl Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("Error", 3)?;
        st.serialize_field("code", self.code())?;
        st.serialize_field("message", &self.to_string())?;
        let log: &[String] = match self {
            Error::Ffmpeg { log, .. } => log,
            _ => &[],
        };
        st.serialize_field("log", log)?;
        st.end()
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// Превращает хвост лога ffmpeg в понятное человеку объяснение.
pub fn explain_ffmpeg_failure(log: &[String]) -> String {
    let joined = log.join("\n").to_lowercase();
    let rules: &[(&str, &str)] = &[
        ("no space left", "На диске закончилось место."),
        ("permission denied", "Нет доступа к файлу или папке (возможно, файл открыт в другой программе или его блокирует антивирус)."),
        ("invalid data found", "Один из файлов повреждён или имеет неподдерживаемый формат."),
        ("moov atom not found", "Видеофайл не дописан до конца (копирование прервалось или запись с камеры оборвалась)."),
        ("cannot load", "Не удалось инициализировать видеокарту — попробуйте режим «Только процессор»."),
        ("no capable devices", "Видеокарта не поддерживает аппаратное кодирование — попробуйте режим «Только процессор»."),
        ("out of memory", "Не хватило памяти — закройте другие программы или уменьшите разрешение."),
        ("no such file", "Файл не найден — возможно, его переместили или удалили."),
    ];
    for (needle, msg) in rules {
        if joined.contains(needle) {
            return (*msg).to_string();
        }
    }
    "Видеодвижок завершился с ошибкой. Подробности — в журнале сборки.".to_string()
}
