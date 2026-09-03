from __future__ import annotations


STATIC_CAPTURE_FIELDS = ('captureScript', 'captureScriptSha256', 'captureDependencies')
BROWSER_CAPTURE_FIELDS = ('browser', 'browserLaunch', 'captureRuntime')


def _apply_provenance(report, current, fields, label, *, append):
    provenance = {field: current[field] for field in fields}
    if append:
        mismatches = [field for field, value in provenance.items() if report.get(field) != value]
        if mismatches:
            changed = ', '.join(mismatches)
            raise RuntimeError(
                f'Cannot append evidence because retained {label} provenance differs: {changed}. '
                'Run a full capture with META_WEBMCP_EVIDENCE_APPEND unset.'
            )
    report.update(provenance)


def apply_static_capture_provenance(report, current, *, append):
    _apply_provenance(report, current, STATIC_CAPTURE_FIELDS, 'static capture', append=append)


def apply_browser_capture_provenance(report, current, *, append):
    _apply_provenance(report, current, BROWSER_CAPTURE_FIELDS, 'browser', append=append)
