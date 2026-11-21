"""TEMPORARY: the Qt-free part of upstream's project document, until upstream request 5.

Upstream keeps it in copper_and_code_studio/ui/document.py (ProjectDocument, SnapshotCommand) and
ui/main_files.py (_default_project), both of which import Qt, so they cannot run in Pyodide.
This file follows them line by line, with QUndoStack replaced by the few rules of it that they
use. When upstream moves this logic into a Qt-free module, the glue imports it from there and
this file is deleted (docs/decisions.md, "Phase 2").

Upstream v0.8.0 is the reference; any difference from it is a bug here.
"""

import copy
from pathlib import Path
from uuid import uuid4

from copper_and_code_studio.core.boards import portable_profile
from copper_and_code_studio.core.i18n import tr
from copper_and_code_studio.core.model import Project, file_revision

NEW_PROJECT_BOARD = "stm32h7_core_v1_3_1024x600"  # ui/main_files.py: without saved defaults, a new project is for this board


class ExternalChangeError(Exception):
    """The file changed on disk, or disappeared, after the last open or save."""

    def __init__(self, path, deleted=False):
        super().__init__(str(path))
        self.path = path
        self.deleted = deleted


class SnapshotCommand:
    """ui/document.py SnapshotCommand, without QUndoCommand."""

    def __init__(self, document, description, mutator, merge_id=-1):
        self.text = tr(description)
        self._lvgl_source_text = description
        self.document = document
        self.mutator = mutator
        self.before = copy.deepcopy(document.project.to_dict())
        self.after = None
        self.merge_id = merge_id

    def redo(self):
        if self.after is None:
            self.mutator(self.document.project)
            self.after = copy.deepcopy(self.document.project.to_dict())
        else:
            self.document._restore(self.after)

    def undo(self):
        self.document._restore(self.before)

    def id(self):
        return self.merge_id

    def mergeWith(self, other):
        if self.merge_id < 0 or other.merge_id != self.merge_id or self.after is None:
            return False
        self.after = copy.deepcopy(other.after)
        return True


class UndoStack:
    """The part of QUndoStack that ProjectDocument relies on: push with merging, undo, redo, clean state."""

    def __init__(self):
        self.commands = []
        self.index = 0
        self.clean_index = 0

    def push(self, command):
        command.redo()
        del self.commands[self.index:]
        if self.clean_index > self.index:
            self.clean_index = -1  # the clean state was in the redo history just dropped
        top = self.commands[-1] if self.commands else None
        # QUndoStack merges into the top command only if it has the same id and is not the clean state.
        if top is not None and top.id() != -1 and top.id() == command.id() and self.index != self.clean_index and top.mergeWith(command):
            return
        self.commands.append(command)
        self.index += 1

    def can_undo(self):
        return self.index > 0

    def can_redo(self):
        return self.index < len(self.commands)

    def undo(self):
        if self.can_undo():
            self.index -= 1
            self.commands[self.index].undo()

    def redo(self):
        if self.can_redo():
            self.commands[self.index].redo()
            self.index += 1

    def undo_text(self):
        return self.commands[self.index - 1].text if self.can_undo() else ""

    def redo_text(self):
        return self.commands[self.index].text if self.can_redo() else ""

    def is_clean(self):
        return self.index == self.clean_index

    def set_clean(self):
        self.clean_index = self.index

    def clear(self):
        self.commands = []
        self.index = 0
        self.clean_index = 0


class ProjectDocument:
    """ui/document.py ProjectDocument, without QObject and its signals."""

    def __init__(self, project=None):
        self.project = project or Project()
        self.path = None
        self.undo_stack = UndoStack()
        self.read_only = False
        self.clipboard = []
        # Revision of the file as we last read or wrote it; None if there is no file.
        self.disk_revision = None

    @property
    def modified(self):
        return not self.undo_stack.is_clean()

    def _restore(self, data):
        project_id = self.project.projectId  # the identity does not follow undo and redo
        self.project = Project.from_dict(copy.deepcopy(data))
        self.project.projectId = project_id

    def execute(self, description, mutator, merge_id=-1, code_only=False):
        if self.read_only:
            return False
        self.undo_stack.push(SnapshotCommand(self, description, mutator, merge_id))
        return True

    def new(self, project=None):
        self.path = None
        self.disk_revision = None
        self.project = project or Project()
        self.undo_stack.set_clean()
        self.undo_stack.clear()

    def open(self, path):
        project, revision = Project.load_with_revision(path)
        self.path = Path(path)
        self.disk_revision = revision
        self.project = project
        self.undo_stack.set_clean()
        self.undo_stack.clear()

    def external_change(self):
        """None if the file is as we left it, otherwise "changed" or "deleted"."""
        if self.path is None or self.disk_revision is None:
            return None
        current = file_revision(self.path)
        if current is None:
            return "deleted"
        return "changed" if current != self.disk_revision else None

    def reload(self):
        self.open(self.path)

    def save(self, path=None, overwrite_external=False):
        """Save. On the open file refuse to erase an outside change, unless overwrite_external."""
        target = Path(path) if path else self.path
        if not target:
            raise ValueError("Nessun percorso di salvataggio")
        same_file = self.path is not None and target.resolve() == self.path.resolve()
        state = self.external_change() if same_file and not overwrite_external else None
        if state:
            raise ExternalChangeError(target, deleted=state == "deleted")
        previous = self.project.projectId
        if not previous or (self.path is not None and not same_file):
            self.project.projectId = uuid4().hex  # Save As creates a separate project
        try:
            revision = self.project.save(target)
        except Exception:
            self.project.projectId = previous
            raise
        self.path = target
        self.disk_revision = revision
        self.undo_stack.set_clean()
        return target


def default_project(defaults, profile_store):
    """ui/main_files.py _default_project: the defaults saved by the user, or else the
    STM32H7_CORE V1.3 at 1024x600. defaults is the parsed setting, or None."""
    project = Project()
    try:
        defaults = defaults or {"board": NEW_PROJECT_BOARD}
        profile = profile_store.get(defaults.get("board"))
        if profile:
            project.board = portable_profile(profile)
            project.set_display_size(profile["logicalWidth"], profile["logicalHeight"])
        elif defaults.get("width"):
            project.set_display_size(defaults["width"], defaults["height"])
        project.runTarget = defaults.get("runTarget")
    except (AttributeError, KeyError, TypeError, ValueError):
        return Project()
    return project
