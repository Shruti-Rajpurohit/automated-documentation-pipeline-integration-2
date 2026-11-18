from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status

from app.api.dependencies import get_current_user
from app.db.job_queue import JobQueueConfigurationError, get_job
from app.db.models import User

router = APIRouter(prefix="/jobs", tags=["pipeline jobs"])
Reader = Annotated[User, Depends(get_current_user)]


@router.get("/{job_id}")
async def job_status(job_id: str, actor: Reader) -> dict[str, object]:
    try:
        job = await get_job(job_id)
    except JobQueueConfigurationError as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(error),
        ) from error
    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pipeline job not found")
    return job
