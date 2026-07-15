import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Settings, ChevronDown, Plus, Archive } from 'lucide-react';
import { SettingsModal } from './SettingsModal';
import { projectStore } from '../lib/projectStore';
import { listProjects, type Project } from '../lib/lyriaClient';

// Formats a project's updatedAt as a short relative string ("2m ago", "3h ago", "5d ago")
// for the PROJECTS dropdown rows.
function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const diffMs = Date.now() - then;
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function TopBar() {
  const [projectName, setProjectName] = useState('Nocturnal Drive');
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [isEditingProject, setIsEditingProject] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isProjectsOpen, setIsProjectsOpen] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);

  const pillRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Boot the project store exactly once and sync local display state to whichever
  // project it loads/switches to (initial load, switchTo, createNew, post-archive fallback).
  useEffect(() => {
    void projectStore.init();

    const handleLoad = (e: Event) => {
      const project = (e as CustomEvent<{ project: Project }>).detail?.project;
      if (!project) return;
      setProjectName(project.name);
      setCurrentId(project.id);
    };
    window.addEventListener('lyria-project-load', handleLoad);
    return () => window.removeEventListener('lyria-project-load', handleLoad);
  }, []);

  // Refresh the dropdown's project list whenever it opens, and whenever the store
  // loads a different project (so a rename/create/archive elsewhere is reflected).
  const refreshProjects = () => {
    listProjects().then(setProjects);
  };

  useEffect(() => {
    if (isProjectsOpen) refreshProjects();
  }, [isProjectsOpen]);

  useEffect(() => {
    const handleLoad = () => {
      if (isProjectsOpen) refreshProjects();
    };
    window.addEventListener('lyria-project-load', handleLoad);
    return () => window.removeEventListener('lyria-project-load', handleLoad);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isProjectsOpen]);

  // Click/focus outside the pill+portaled dropdown closes it — same outside-collapse
  // convention SidebarLeft uses for its popouts.
  useEffect(() => {
    if (!isProjectsOpen) return;
    const handleOutside = (e: Event) => {
      const target = e.target as Node;
      const insidePill = pillRef.current?.contains(target);
      const insideDropdown = dropdownRef.current?.contains(target);
      if (!insidePill && !insideDropdown) {
        setIsProjectsOpen(false);
      }
    };
    window.addEventListener('pointerdown', handleOutside);
    return () => window.removeEventListener('pointerdown', handleOutside);
  }, [isProjectsOpen]);

  const commitProjectName = () => {
    setIsEditingProject(false);
    projectStore.update({ name: projectName });
  };

  const handleSwitch = (project: Project) => {
    void projectStore.switchTo(project);
    setIsProjectsOpen(false);
  };

  const handleCreateNew = () => {
    void projectStore.createNew();
    setIsProjectsOpen(false);
  };

  const handleArchive = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    void projectStore.archive(id).then(refreshProjects);
  };

  return (
    <div className="h-16 shrink-0 border-b border-lyria-border flex items-center justify-center px-6 bg-lyria-bg/80 backdrop-blur-sm z-10 relative">
      <SettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} />

     <div className="w-full max-w-[1600px] mx-auto flex items-center justify-between">

      {/* Left: Logo (decorative — not a link/button, so no pointer cursor and no hover feedback) */}
      <div className="flex items-center gap-4">
        <div className="flex items-baseline gap-2">
          <span className="font-display text-2xl font-light tracking-[0.2em] text-lyria-gold">LYRIA 3</span>
          <span className="ml-1 px-1.5 py-0.5 border border-lyria-border rounded text-[10px] font-mono tracking-wider text-lyria-text-muted">PRO</span>
        </div>
      </div>

      {/* Center: Project Info */}
      <div ref={pillRef} className="flex items-center gap-8 bg-[#110e0c]/80 backdrop-blur-md px-8 py-2.5 rounded-2xl border border-[#2b2521] shadow-[inset_0_1px_0_rgba(255,255,255,0.03),0_4px_20px_rgba(0,0,0,0.5)] relative overflow-hidden group">
        <div className="absolute inset-0 bg-gradient-to-b from-white/5 to-transparent opacity-50 mix-blend-overlay pointer-events-none"></div>

        <div className="flex items-center gap-1.5 relative z-10">
          <div
            role="button"
            tabIndex={isEditingProject ? -1 : 0}
            className="flex flex-col cursor-pointer rounded lyria-focus-ring"
            onClick={() => setIsEditingProject(true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setIsEditingProject(true);
              }
            }}
            aria-label={isEditingProject ? undefined : `Rename project, currently "${projectName}"`}
            title={isEditingProject ? undefined : "Click to rename this project"}
          >
            <span className="font-display text-[9px] text-[#8b837c] uppercase tracking-widest mb-0.5 group-hover:text-lyria-text-muted transition-colors">PROJECT</span>
            {isEditingProject ? (
              <input
                type="text"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                onBlur={commitProjectName}
                onKeyDown={(e) => e.key === 'Enter' && commitProjectName()}
                aria-label="Project name"
                className="text-sm text-lyria-text-main font-medium drop-shadow-[0_0_10px_rgba(255,255,255,0.1)] bg-transparent border-b border-lyria-gold focus:outline-none w-28"
                autoFocus
              />
            ) : (
              <span className="text-sm text-lyria-text-main font-medium drop-shadow-[0_0_10px_rgba(255,255,255,0.1)] group-hover:text-white transition-colors truncate max-w-[150px]">{projectName}</span>
            )}
          </div>
          <button
            onClick={() => setIsProjectsOpen(open => !open)}
            title="Open the projects library — switch project or create new"
            aria-label={isProjectsOpen ? 'Close projects library' : 'Open projects library'}
            aria-expanded={isProjectsOpen}
            className={`p-1 rounded hover:bg-black/30 transition-colors duration-150 mt-2 cursor-pointer lyria-focus-ring ${isProjectsOpen ? 'text-lyria-gold' : 'text-lyria-text-muted hover:text-lyria-text-main'}`}
          >
            <ChevronDown size={12} className={`transition-transform duration-150 ${isProjectsOpen ? 'rotate-180' : ''}`} />
          </button>
        </div>
      </div>

      {isProjectsOpen && (
        <ProjectsDropdown
          anchorRef={pillRef}
          dropdownRef={dropdownRef}
          projects={projects}
          currentId={currentId}
          onSwitch={handleSwitch}
          onCreateNew={handleCreateNew}
          onArchive={handleArchive}
        />
      )}

      {/* Right: Actions */}
      <div className="flex items-center gap-6">
        <button
          onClick={() => setIsSettingsOpen(true)}
          title="Open settings — API keys and provider choice"
          className="flex flex-col items-center gap-1 text-lyria-text-muted hover:text-lyria-text-main transition-colors duration-150 active:scale-[0.98] cursor-pointer rounded lyria-focus-ring"
        >
          <Settings size={16} strokeWidth={1.5} />
          <span className="text-[9px] uppercase tracking-widest">SETTINGS</span>
        </button>
      </div>

     </div>
    </div>
  );
}

interface ProjectsDropdownProps {
  anchorRef: React.RefObject<HTMLDivElement | null>;
  dropdownRef: React.RefObject<HTMLDivElement | null>;
  projects: Project[];
  currentId: string | null;
  onSwitch: (project: Project) => void;
  onCreateNew: () => void;
  onArchive: (e: React.MouseEvent, id: string) => void;
}

// Portaled to <body>: TopBar's backdrop-blur (like SettingsModal's overlay) makes it a
// containing block for fixed-position descendants, which would trap this dropdown inside
// the 64px bar instead of floating over the rest of the app. Positioned via the pill's own
// getBoundingClientRect() rather than CSS anchoring, since the portal target (body) shares
// no layout parent with the pill anymore.
function ProjectsDropdown({ anchorRef, dropdownRef, projects, currentId, onSwitch, onCreateNew, onArchive }: ProjectsDropdownProps) {
  const [coords, setCoords] = useState<{ top: number; left: number; width: number } | null>(null);

  useEffect(() => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (rect) {
      setCoords({ top: rect.bottom + 8, left: rect.left, width: Math.max(rect.width, 220) });
    }
  }, [anchorRef]);

  if (!coords) return null;

  return createPortal(
    <div
      ref={dropdownRef}
      style={{ position: 'fixed', top: coords.top, left: coords.left, width: coords.width }}
      className="z-50 bg-[#14110f] border border-lyria-border rounded-xl shadow-2xl overflow-hidden"
    >
      <div className="max-h-64 overflow-y-auto py-1">
        {projects.length === 0 && (
          <div className="px-3 py-3 text-[11px] text-lyria-text-muted text-center">No projects yet</div>
        )}
        {projects.map((project) => (
          <div
            key={project.id}
            role="button"
            tabIndex={0}
            onClick={() => onSwitch(project)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSwitch(project);
              }
            }}
            title={project.id === currentId ? undefined : "Switch to this project"}
            aria-label={project.id === currentId ? `${project.name} (current project)` : `Switch to project ${project.name}`}
            className={`group flex items-center justify-between gap-2 px-3 py-2 cursor-pointer hover:bg-white/5 transition-colors duration-150 lyria-focus-ring ${
              project.id === currentId ? 'bg-lyria-gold/10' : ''
            }`}
          >
            <div className="flex flex-col min-w-0">
              <span className={`text-xs font-medium truncate ${project.id === currentId ? 'text-lyria-gold' : 'text-lyria-text-main'}`}>
                {project.name}
              </span>
              <span className="text-[10px] text-lyria-text-muted">{relativeTime(project.updatedAt)}</span>
            </div>
            {project.id !== currentId && (
              <button
                onClick={(e) => onArchive(e, project.id)}
                title="Archive this project — file moves to projects/archived/, never deleted"
                aria-label={`Archive project ${project.name}`}
                className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 text-lyria-text-muted hover:text-lyria-signal transition-opacity duration-150 p-1 shrink-0 cursor-pointer lyria-focus-ring rounded"
              >
                <Archive size={12} />
              </button>
            )}
          </div>
        ))}
      </div>
      <button
        onClick={onCreateNew}
        title="Create a new, empty project"
        className="w-full flex items-center gap-2 px-3 py-2.5 border-t border-lyria-border text-[11px] uppercase tracking-widest text-lyria-gold hover:bg-lyria-gold/10 transition-colors duration-150 cursor-pointer lyria-focus-ring"
      >
        <Plus size={12} /> New Project
      </button>
    </div>,
    document.body
  );
}
