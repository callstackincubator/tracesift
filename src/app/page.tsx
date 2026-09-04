"use client";

import { ChangeEvent, DragEvent, useId, useState } from "react";

type ProfileType = "javascript" | "react";
type UploadKind = "cpu" | "sourceMap" | "reactProfile";

const acceptedFiles: Record<UploadKind, string> = {
  cpu: ".cpuprofile,.json,application/json",
  sourceMap: ".map,.json,application/json",
  reactProfile: ".json,application/json",
};

function ProfileIcon({ type }: { type: ProfileType }) {
  if (type === "javascript") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6.75 4.75h10.5a2 2 0 0 1 2 2v10.5a2 2 0 0 1-2 2H6.75a2 2 0 0 1-2-2V6.75a2 2 0 0 1 2-2Z" />
        <path d="M9.5 9.25v5.1c0 1.1-.62 1.65-1.85 1.65M16.4 10.05c-.46-.54-1.06-.8-1.8-.8-.9 0-1.55.45-1.55 1.17 0 .7.5.99 1.6 1.36 1.16.39 1.85.85 1.85 1.95 0 1.34-1.07 2.27-2.62 2.27-.98 0-1.78-.32-2.4-.96" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <ellipse cx="12" cy="12" rx="9" ry="3.6" />
      <ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(60 12 12)" />
      <ellipse cx="12" cy="12" rx="9" ry="3.6" transform="rotate(120 12 12)" />
      <circle cx="12" cy="12" r="1.6" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14.5v3.75A1.75 1.75 0 0 0 6.75 20h10.5A1.75 1.75 0 0 0 19 18.25V14.5" />
    </svg>
  );
}

function UploadPane({
  kind,
  title,
  detail,
  file,
  onFile,
}: {
  kind: UploadKind;
  title: string;
  detail: string;
  file?: File;
  onFile: (file?: File) => void;
}) {
  const inputId = useId();
  const [isDragging, setIsDragging] = useState(false);

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    onFile(event.target.files?.[0]);
  };

  const handleDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setIsDragging(false);
    onFile(event.dataTransfer.files?.[0]);
  };

  return (
    <label
      className={`upload-pane${isDragging ? " is-dragging" : ""}${file ? " has-file" : ""}`}
      htmlFor={inputId}
      onDragEnter={(event) => {
        event.preventDefault();
        setIsDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
    >
      <input id={inputId} type="file" accept={acceptedFiles[kind]} onChange={handleChange} />
      <span className="upload-icon"><UploadIcon /></span>
      <span className="upload-title">{file ? file.name : title}</span>
      <span className="upload-detail">{file ? "Ready to analyze" : detail}</span>
      <span className="browse-button">{file ? "Replace file" : "Browse files"}</span>
    </label>
  );
}

export default function Home() {
  const [profileType, setProfileType] = useState<ProfileType>("javascript");
  const [files, setFiles] = useState<Partial<Record<UploadKind, File>>>({});

  const updateFile = (kind: UploadKind, file?: File) => {
    setFiles((current) => ({ ...current, [kind]: file }));
  };

  const isReady = profileType === "javascript"
    ? Boolean(files.cpu && files.sourceMap)
    : Boolean(files.reactProfile);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand" aria-label="RN Profile Inspector">
          <span className="brand-mark"><ProfileIcon type="react" /></span>
          <span>RN Profile <strong>Inspector</strong></span>
        </div>
        <div className="local-badge"><span /> Runs locally in your browser</div>
      </header>

      <section className="workspace">
        <div className="intro">
          <span className="eyebrow">React Native performance</span>
          <h1>What would you like to analyze?</h1>
          <p>Choose a profile type, then add the files captured from your React Native app.</p>
        </div>

        <div className="profile-options" role="radiogroup" aria-label="Profile type">
          <button type="button" role="radio" aria-checked={profileType === "javascript"} className={`profile-option${profileType === "javascript" ? " selected" : ""}`} onClick={() => setProfileType("javascript")}>
            <span className="profile-icon"><ProfileIcon type="javascript" /></span>
            <span className="option-copy"><strong>JavaScript CPU profile</strong><small>Inspect call stacks and JavaScript execution time</small></span>
            <span className="radio-indicator" />
          </button>

          <button type="button" role="radio" aria-checked={profileType === "react"} className={`profile-option${profileType === "react" ? " selected" : ""}`} onClick={() => setProfileType("react")}>
            <span className="profile-icon"><ProfileIcon type="react" /></span>
            <span className="option-copy"><strong>React component profile</strong><small>Find expensive renders and component updates</small></span>
            <span className="radio-indicator" />
          </button>
        </div>

        <section className="upload-section" aria-live="polite">
          <div className="section-heading">
            <div><span className="step-number">2</span><h2>Add profile files</h2></div>
            <p>{profileType === "javascript" ? "Both files are required" : "One file required"}</p>
          </div>

          <div className={`upload-grid ${profileType === "react" ? "single" : ""}`}>
            {profileType === "javascript" ? (
              <>
                <UploadPane kind="cpu" title="JavaScript CPU profile" detail="Drop a .cpuprofile or .json file here" file={files.cpu} onFile={(file) => updateFile("cpu", file)} />
                <UploadPane kind="sourceMap" title="Source map" detail="Drop the matching .map or .json file here" file={files.sourceMap} onFile={(file) => updateFile("sourceMap", file)} />
              </>
            ) : (
              <UploadPane kind="reactProfile" title="React component profile" detail="Drop a React DevTools profiling .json file here" file={files.reactProfile} onFile={(file) => updateFile("reactProfile", file)} />
            )}
          </div>
        </section>

        <div className="action-row">
          <p>Files stay on this device and are processed locally.</p>
          <button className="analyze-button" type="button" disabled={!isReady}>
            Analyze profile
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7.5 4 6 6-6 6" /></svg>
          </button>
        </div>
      </section>
    </main>
  );
}
