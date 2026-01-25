#!/usr/bin/env python
"""
Media Processing and Ingestion Pipeline

This script handles the end-to-end process of transcribing audio/video content and ingesting it into a searchable database:
- Processes both local audio files and YouTube videos
- Transcribes media using OpenAI's Whisper model
- Chunks transcriptions into meaningful segments
- Creates embeddings and stores them in Pinecone for semantic search
- Uploads original media files to S3
- Handles parallel processing with a worker pool
- Provides progress tracking and detailed reporting

Key Features:
- Fault tolerance with retry logic and graceful error handling
- Caching of transcriptions to avoid redundant processing
- Rate limiting protection
- Progress bars and detailed logging
- Graceful shutdown handling
- Support for parallel instances via separate queues

Command Line Options:

Required:
  -s, --site SITE              Site ID for environment variables

Processing Control:
  -f, --force                  Force re-transcription and re-indexing
  -c, --clear-vectors          Clear existing vectors before processing
  -o, --override-conflicts     Continue processing even if filename conflicts are found

Queue Management:
  -q, --queue NAME             Specify an alternative queue name for parallel processing

Testing & Development:
  -D, --dryrun                 Perform a dry run without sending data to Pinecone or S3

Debug & Logging:
  -d, --debug                  Enable debug logging

Usage Examples:
  python transcribe_and_ingest_media.py -s ananda
  python transcribe_and_ingest_media.py -s ananda -f -d
  python transcribe_and_ingest_media.py -s ananda -D
  python transcribe_and_ingest_media.py -s ananda -q queue-bhaktan
  python transcribe_and_ingest_media.py -s ananda -q queue-treasures
"""

import argparse
import atexit
import logging
import os
import signal
import sys
import time
from multiprocessing import Event, Pool, Queue, cpu_count
from queue import Empty

from openai import OpenAI
from tenacity import RetryError
from tqdm import tqdm

# Add project root to Python path so imports work when running from data_ingestion directory
_script_dir = os.path.dirname(os.path.abspath(__file__))
_project_root = os.path.dirname(os.path.dirname(_script_dir))
if _project_root not in sys.path:
    sys.path.insert(0, _project_root)

from data_ingestion.audio_video.IngestQueue import IngestQueue  # noqa: E402
from data_ingestion.audio_video.media_utils import (  # noqa: E402
    get_media_metadata,
    print_chunk_statistics,
)
from data_ingestion.audio_video.pinecone_utils import (  # noqa: E402
    create_embeddings,
    load_pinecone,
    store_in_pinecone,
)
from data_ingestion.audio_video.processing_time_estimates import (  # noqa: E402
    save_estimate,
)
from data_ingestion.audio_video.transcription_utils import (  # noqa: E402
    RateLimitError,
    UnsupportedAudioFormatError,
    chunk_transcription,
    get_saved_transcription,
    init_db,
    load_youtube_data_map,
    save_transcription,
    save_youtube_transcription,
    transcribe_media,
)
from data_ingestion.audio_video.youtube_utils import (  # noqa: E402
    download_youtube_audio,
    extract_youtube_id,
)
from data_ingestion.utils.author_normalization import normalize_author  # noqa: E402
from data_ingestion.utils.pinecone_utils import clear_library_vectors  # noqa: E402
from data_ingestion.utils.s3_utils import S3UploadError, upload_to_s3  # noqa: E402
from pyutil.env_utils import load_env  # noqa: E402
from pyutil.logging_utils import configure_logging  # noqa: E402
from pyutil.site_config_utils import (  # noqa: E402
    determine_access_level,
    load_site_config,
)

logger = logging.getLogger(__name__)


def reset_terminal():
    """Reset the terminal to its normal state."""
    if os.name == "posix":  # For Unix-like systems
        os.system("stty sane")
    print("\033[?25h", end="")  # Show the cursor
    print("\033[0m", end="")  # Reset all attributes
    print("", flush=True)  # Ensure a newline and flush the output


# Register the reset_terminal function to be called on exit
atexit.register(reset_terminal)


def verify_and_update_transcription_metadata(
    transcription_data,
    file_path,
    author,
    library_name,
    is_youtube_video,
    youtube_data=None,
    site=None,
):
    """
    Verifies and updates metadata in transcription JSON file.
    Returns updated transcription data.
    """
    # Handle legacy format (just text string)
    if not isinstance(transcription_data, dict):
        transcription_data = {
            "text": transcription_data,
            "words": [],  # No word timestamps in legacy format
        }

    # Get current timestamp
    current_time = time.strftime("%Y-%m-%d %H:%M:%S")

    # Update core fields
    transcription_data.update(
        {
            "file_path": file_path,
            "author": normalize_author(author, site),
            "library": library_name,
            "type": "youtube" if is_youtube_video else "audio_file",
            "updated_at": current_time,
            "media_type": "video" if is_youtube_video else "audio",
        }
    )

    # Set created_at only if it doesn't exist
    if "created_at" not in transcription_data:
        transcription_data["created_at"] = current_time

    if is_youtube_video:
        # Load existing YouTube data from storage if not provided
        if not youtube_data:
            youtube_id = transcription_data.get("youtube_id")
            if youtube_id and site:
                youtube_data_map = load_youtube_data_map(site)
                youtube_data = youtube_data_map.get(youtube_id)

        if youtube_data and "media_metadata" in youtube_data:
            yt_metadata = youtube_data["media_metadata"]
            transcription_data.update(
                {
                    "title": yt_metadata.get("title"),
                    "source_url": yt_metadata.get("url"),
                    "duration": yt_metadata.get("duration"),
                    "file_name": f"YouTube_{youtube_data['youtube_id']}",
                    "youtube_id": youtube_data["youtube_id"],
                    "upload_date": yt_metadata.get("upload_date"),
                    "channel": yt_metadata.get("channel"),
                    "view_count": yt_metadata.get("view_count"),
                    "description": yt_metadata.get("description"),
                }
            )

            # Save the updated transcription file
            save_transcription(
                file_path,
                transcription_data,
                youtube_id=youtube_data["youtube_id"],
                site=site,
            )
    else:
        # Only try to get file metadata for local audio files that exist
        if file_path and os.path.exists(file_path):
            # Get metadata for local audio file
            title, mp3_author, duration, url, album = get_media_metadata(
                file_path, site
            )
            transcription_data.update(
                {
                    "title": title,
                    "author": normalize_author(
                        mp3_author if mp3_author != "Unknown" else author, site
                    ),
                    "file_name": os.path.basename(file_path),
                    "duration": duration,
                    "album": album,
                }
            )

            # Get additional file metadata
            try:
                file_stats = os.stat(file_path)
                transcription_data.update(
                    {
                        "file_size": file_stats.st_size,
                        "format": os.path.splitext(file_path)[1][1:].lower(),
                    }
                )
            except Exception as e:
                logger.warning(f"Could not get file stats: {str(e)}")

            # Save transcription file
            save_transcription(file_path, transcription_data, site=site)

    return transcription_data


def _validate_and_setup_processing(
    file_path, is_youtube_video, youtube_data, default_author, library_name
):
    """
    Validates parameters and sets up basic processing variables.
    Returns tuple of (file_name, youtube_id, local_report) or (None, None, error_report) on error.
    """
    local_report = {
        "processed": 0,
        "skipped": 0,
        "errors": 0,
        "error_details": [],
        "warnings": [],
        "fully_indexed": 0,
        "chunk_lengths": [],
        "private_videos": 0,
    }

    if is_youtube_video and youtube_data.get("error") == "private_video":
        local_report["private_videos"] += 1
        local_report["error_details"].append(
            f"Private video (inaccessible): {youtube_data['url']}"
        )
        return None, None, local_report

    if is_youtube_video:
        youtube_id = youtube_data["youtube_id"]
        file_name = f"YouTube_{youtube_id}"
        file_path = youtube_data.get("audio_path")
    else:
        youtube_id = None
        file_name = os.path.basename(file_path) if file_path else "Unknown_File"

    return file_name, youtube_id, local_report


def _perform_transcription(
    file_path, file_name, is_youtube_video, youtube_id, force, youtube_data, site
):
    """
    Performs the actual transcription with comprehensive error handling.
    Returns tuple of (transcription, local_report).
    """
    local_report = {
        "processed": 0,
        "skipped": 0,
        "errors": 0,
        "error_details": [],
        "warnings": [],
        "fully_indexed": 0,
        "chunk_lengths": [],
        "private_videos": 0,
    }

    logger.info(
        f"\nTranscribing {'YouTube video' if is_youtube_video else 'audio'} for {file_name}"
    )

    try:
        transcription = transcribe_media(
            file_path, force, is_youtube_video, youtube_id, site=site
        )
        if transcription:
            local_report["processed"] += 1
            # Cache YouTube transcriptions for future use
            if is_youtube_video:
                save_youtube_transcription(youtube_data, file_path, transcription, site)
            return transcription, local_report
        else:
            error_msg = f"Error transcribing {'YouTube video' if is_youtube_video else 'file'} {file_name}: No transcripts generated"
            logger.error(error_msg)
            local_report["errors"] += 1
            local_report["error_details"].append(error_msg)
            return None, local_report
    except RetryError as e:
        error_msg = f"Failed to transcribe {file_name} after multiple retries: {str(e)}"
        logger.error(error_msg)
        local_report["errors"] += 1
        local_report["error_details"].append(error_msg)
        return None, local_report
    except RateLimitError:
        error_msg = (
            f"Rate limit exceeded while transcribing {file_name}. Terminating process."
        )
        logger.error(error_msg)
        local_report["errors"] += 1
        local_report["error_details"].append(error_msg)
        return None, local_report
    except UnsupportedAudioFormatError as e:
        error_msg = f"{str(e)}. Stopping processing for file {file_name}."
        logger.error(error_msg)
        local_report["errors"] += 1
        local_report["error_details"].append(error_msg)
        return None, local_report
    except Exception as e:
        error_msg = f"Error transcribing {'YouTube video' if is_youtube_video else 'file'} {file_name}: {str(e)}"
        logger.error(error_msg)
        logger.error(f"Error type: {type(e).__name__}")
        logger.error(f"Error details: {str(e)}")
        logger.exception("Full traceback:")
        local_report["errors"] += 1
        local_report["error_details"].append(error_msg)
        return None, local_report


def _handle_transcription(
    file_path,
    file_name,
    is_youtube_video,
    youtube_id,
    force,
    default_author,
    library_name,
    youtube_data,
    site,
):
    """
    Handles transcription logic - checking cache and transcribing if needed.
    Returns tuple of (transcription, local_report).
    """
    local_report = {
        "processed": 0,
        "skipped": 0,
        "errors": 0,
        "error_details": [],
        "warnings": [],
        "fully_indexed": 0,
        "chunk_lengths": [],
        "private_videos": 0,
    }

    # Check cache first to avoid redundant processing
    try:
        existing_transcription = get_saved_transcription(
            file_path, is_youtube_video, youtube_id, site
        )
    except Exception as e:
        error_msg = (
            f"Error checking for existing transcription for {file_name}: {str(e)}"
        )
        logger.error(error_msg)
        local_report["errors"] += 1
        local_report["error_details"].append(error_msg)
        return None, local_report

    if existing_transcription and not force:
        # Verify and update metadata in existing transcription
        try:
            transcription = verify_and_update_transcription_metadata(
                existing_transcription,
                file_path,
                default_author,
                library_name,
                is_youtube_video,
                youtube_data,
                site,
            )
            local_report["skipped"] += 1
            logger.debug(
                f"Using existing transcription with updated metadata for {file_name}"
            )
            return transcription, local_report
        except Exception as e:
            error_msg = f"Error updating metadata for {file_name}: {str(e)}"
            logger.error(error_msg)
            local_report["errors"] += 1
            local_report["error_details"].append(error_msg)
            return None, local_report
    else:
        # Validate we have audio file if we need to transcribe
        if not file_path:
            error_msg = f"No audio file path found for {'YouTube video' if is_youtube_video else 'file'} {file_name}"
            logger.error(error_msg)
            local_report["errors"] += 1
            local_report["error_details"].append(error_msg)
            return None, local_report

        # Perform transcription
        return _perform_transcription(
            file_path,
            file_name,
            is_youtube_video,
            youtube_id,
            force,
            youtube_data,
            site,
        )


def _process_and_store_transcription(
    transcription,
    file_name,
    file_path,
    pinecone_index,
    client,
    dryrun,
    is_youtube_video,
    youtube_data,
    default_author,
    library_name,
    s3_key,
    site_config,
    site=None,
):
    """
    Processes transcription into chunks and stores in Pinecone.
    Returns local_report with processing results.
    """
    local_report = {
        "processed": 0,
        "skipped": 0,
        "errors": 0,
        "error_details": [],
        "warnings": [],
        "fully_indexed": 0,
        "chunk_lengths": [],
        "private_videos": 0,
    }

    try:
        if dryrun:
            logger.info(
                f"Dry run mode: Would store chunks for {'YouTube video' if is_youtube_video else 'file'} {file_name} in Pinecone."
            )

        logger.info(f"Processing transcripts for {file_name}")
        chunks = chunk_transcription(transcription)
        if isinstance(chunks, dict) and "error" in chunks:
            error_msg = (
                f"Error chunking transcription for {file_name}: {chunks['error']}"
            )
            logger.error(error_msg)
            local_report["errors"] += 1
            local_report["error_details"].append(error_msg)
            return local_report

        local_report["chunk_lengths"].extend([len(chunk["words"]) for chunk in chunks])

        if not dryrun:
            try:
                # create_embeddings returns (embeddings, valid_chunks) to ensure
                # proper alignment - some chunks may be skipped during validation
                embeddings, valid_chunks = create_embeddings(chunks, client)
                logger.debug(f"{len(embeddings)} embeddings created for {file_name}")

                # Use youtube_data for metadata if it's a YouTube video
                if (
                    is_youtube_video
                    and youtube_data
                    and "media_metadata" in youtube_data
                ):
                    metadata = youtube_data["media_metadata"]
                    title = metadata.get("title", "Unknown Title")
                    url = metadata.get("url")
                    author = normalize_author(default_author, site)
                    album = None  # YouTube videos don't have albums
                else:
                    title, mp3_author, duration, url, album = get_media_metadata(
                        file_path, site
                    )
                    author = normalize_author(
                        mp3_author if mp3_author != "Unknown" else default_author, site
                    )

                # Determine content type and source identifier based on video type
                content_type = "video" if is_youtube_video else "audio"
                source_identifier = url if is_youtube_video else s3_key

                # Load site configuration and determine access level
                access_level = determine_access_level(file_path, site_config)

                logger.debug(
                    f"Determined access_level='{access_level}' for file: {file_path}"
                )

                # Use valid_chunks (not original chunks) to ensure proper alignment
                # with embeddings - some chunks may have been skipped during validation
                store_in_pinecone(
                    pinecone_index,
                    valid_chunks,
                    embeddings,
                    author,
                    library_name,
                    title,
                    content_type,
                    source_identifier,
                    album=album,
                    access_level=access_level,
                )
            except Exception as e:
                error_msg = f"Error processing {'YouTube video' if is_youtube_video else 'file'} {file_name}: {str(e)}"
                logger.error(error_msg)
                logger.error(f"Caught exception: {e}")
                local_report["errors"] += 1
                local_report["error_details"].append(error_msg)
                return local_report

        local_report["fully_indexed"] += 1
        return local_report

    except Exception as e:
        error_msg = f"Error processing {'YouTube video' if is_youtube_video else 'file'} {file_name}: {str(e)}"
        logger.error(error_msg, exc_info=True)
        local_report["errors"] += 1
        local_report["error_details"].append(error_msg)
        return local_report


def _handle_s3_upload(file_path, file_name, s3_key, dryrun, is_youtube_video):
    """
    Handles S3 upload for non-YouTube files.
    Returns local_report with upload results.
    """
    local_report = {
        "processed": 0,
        "skipped": 0,
        "errors": 0,
        "error_details": [],
        "warnings": [],
        "fully_indexed": 0,
        "chunk_lengths": [],
        "private_videos": 0,
    }

    # After successful processing, upload to S3 only if it's not a YouTube video and not a dry run
    if not dryrun and not is_youtube_video and file_path:
        try:
            if not s3_key:
                # Fallback to a default S3 key if not provided
                s3_key = f"public/audio/default/{os.path.basename(file_path)}"

            upload_to_s3(file_path, s3_key)
        except S3UploadError as e:
            error_msg = f"Error uploading {file_name} to S3: {str(e)}"
            logger.error(error_msg)
            local_report["errors"] += 1
            local_report["error_details"].append(error_msg)
            return local_report

    return local_report


def process_file(
    file_path,
    pinecone_index,
    client,
    force,
    dryrun,
    default_author,
    library_name,
    site_config,
    is_youtube_video=False,
    youtube_data=None,
    s3_key=None,
    site=None,
):
    """
    Core processing pipeline for a single media file or YouTube video.

    Flow:
    1. Check for existing transcription in cache
    2. If needed, generate new transcription
    3. Chunk the transcription into segments
    4. Create embeddings for chunks
    5. Store in Pinecone with metadata
    6. Upload original to S3 (non-YouTube only)

    Returns a report dictionary with processing statistics and any errors
    """
    logger.debug(
        f"process_file called with params: file_path={file_path}, index={pinecone_index}, "
        + f"client={client}, force={force}, dryrun={dryrun}, default_author={default_author}, "
        + f"library_name={library_name}, is_youtube_video={is_youtube_video}, youtube_data={youtube_data}, "
        + f"s3_key={s3_key}"
    )

    # Step 1: Validate and setup processing
    file_name, youtube_id, setup_report = _validate_and_setup_processing(
        file_path,
        is_youtube_video,
        youtube_data,
        default_author,
        library_name,
    )

    if file_name is None:  # Error in setup
        return setup_report

    # Step 2: Handle transcription (check cache or transcribe)
    transcription, transcription_report = _handle_transcription(
        file_path,
        file_name,
        is_youtube_video,
        youtube_id,
        force,
        default_author,
        library_name,
        youtube_data,
        site,
    )

    if transcription is None:  # Error in transcription
        return transcription_report

    # Step 3: Process transcription and store in Pinecone
    processing_report = _process_and_store_transcription(
        transcription,
        file_name,
        file_path,
        pinecone_index,
        client,
        dryrun,
        is_youtube_video,
        youtube_data,
        default_author,
        library_name,
        s3_key,
        site_config,
        site=site,
    )

    if processing_report["errors"] > 0:
        return processing_report

    # Step 4: Handle S3 upload
    upload_report = _handle_s3_upload(
        file_path, file_name, s3_key, dryrun, is_youtube_video
    )

    # Merge all reports
    final_report = merge_reports(
        [setup_report, transcription_report, processing_report, upload_report]
    )
    return final_report


def worker(task_queue, result_queue, args, stop_event):
    """
    Worker process that handles media processing tasks from the queue.

    Maintains its own OpenAI client and Pinecone connection to avoid
    sharing resources between processes. Continues processing until
    stop_event is set or queue is empty.
    """
    # Each worker maintains isolated OpenAI/Pinecone connections
    # to avoid resource sharing issues between processes
    configure_logging(args.debug)
    logger = logging.getLogger(__name__)
    client = OpenAI()

    try:
        index = load_pinecone()
    except Exception as e:
        error_msg = str(e)
        # Check for Pinecone plan/region errors
        if (
            "free plan does not support indexes" in error_msg
            or "upgrade your plan" in error_msg
            or "INVALID_ARGUMENT" in error_msg
            or "Bad request" in error_msg
        ):
            logger.error("Pinecone Configuration Error in worker process:")
            logger.error(
                "Your current Pinecone plan does not support the configured region."
            )
            logger.error(
                "Please upgrade your Pinecone plan or change the region configuration."
            )
            # Put error in result queue and exit worker
            result_queue.put(
                (
                    None,
                    {
                        "errors": 1,
                        "error_details": [
                            "Pinecone configuration error: Plan does not support configured region"
                        ],
                    },
                )
            )
            return
        else:
            # Re-raise other exceptions
            raise

    # Load site configuration once per worker
    site_config = load_site_config(args.site)

    item = None
    while not stop_event.is_set():
        try:
            # 1 second timeout prevents workers from hanging indefinitely
            item = task_queue.get(timeout=1)
            if item is None:
                # Poison pill received - worker should terminate
                break

            logger.debug(f"Worker processing item: {item}")
            # Process item and report results back to main thread
            item_id, report = process_item(item, args, client, index, site_config)
            logger.debug(f"Worker processed item: {item_id}, report: {report}")
            result_queue.put((item_id, report))
        except Empty:
            # No work available - keep checking until stop_event is set
            continue
        except Exception as e:
            logger.error(f"Worker error: {str(e)}")
            logger.exception("Full traceback:")
            # Ensure the item ID is included in the error report
            if item is not None:
                result_queue.put((item["id"], {"errors": 1, "error_details": [str(e)]}))
            else:
                result_queue.put((None, {"errors": 1, "error_details": [str(e)]}))


def process_item(item, args, client, index, site_config):
    """
    Processes a single media item with timing metrics and cleanup.

    Handles both audio files and YouTube videos, tracking processing time
    for future estimates. Ensures cleanup of temporary files for YouTube
    content.
    """
    logger.debug(f"Processing item: {item}")

    error_report = {
        "processed": 0,
        "skipped": 0,
        "errors": 1,
        "error_details": [],
        "warnings": [],
        "fully_indexed": 0,
        "chunk_lengths": [],
    }

    if item["type"] == "audio_file":
        file_to_process = item["data"]["file_path"]
        is_youtube_video = False
        youtube_data = None
    elif item["type"] == "youtube_video":
        youtube_data, youtube_id = preprocess_youtube_video(
            item["data"]["url"], logger, args.site
        )
        if not youtube_data:
            logger.error(f"Failed to process YouTube video: {item['data']['url']}")
            error_report["error_details"].append(
                f"Failed to process YouTube video: {item['data']['url']}"
            )
            return item["id"], error_report
        # This may be None if transcript was cached
        file_to_process = youtube_data.get("audio_path")
        is_youtube_video = True
    else:
        logger.error(f"Unknown item type: {item['type']}")
        error_report["error_details"].append(f"Unknown item type: {item['type']}")
        return item["id"], error_report

    logger.debug(f"File to process: {file_to_process}")

    author = item["data"]["author"]
    library = item["data"]["library"]
    s3_key = item["data"].get("s3_key")

    start_time = time.time()
    report = process_file(
        file_to_process,
        index,
        client,
        args.force,
        dryrun=args.dryrun,
        default_author=author,
        library_name=library,
        site_config=site_config,
        is_youtube_video=is_youtube_video,
        youtube_data=youtube_data,
        s3_key=s3_key,
        site=args.site,
    )
    end_time = time.time()
    processing_time = end_time - start_time

    if file_to_process:
        # Save the processing time estimate
        file_size = os.path.getsize(file_to_process)
        save_estimate(item["type"], processing_time, file_size)

    # Clean up temporary YouTube audio file if necessary
    if is_youtube_video and file_to_process and os.path.exists(file_to_process):
        os.remove(file_to_process)
        logger.info(f"Deleted temporary YouTube audio file: {file_to_process}")

    return item["id"], report


def initialize_environment(args):
    load_env(args.site)
    init_db(args.site)
    configure_logging(args.debug)
    return logger


def preprocess_youtube_video(url, logger, site):
    """
    Prepares YouTube video for processing by:
    1. Extracting video ID
    2. Checking for cached transcription
    3. Downloading audio if needed

    Returns tuple of (youtube_data, youtube_id) where youtube_data contains
    metadata and local audio path
    """
    youtube_id = extract_youtube_id(url)
    youtube_data_map = load_youtube_data_map(site)
    existing_youtube_data = youtube_data_map.get(youtube_id)

    if existing_youtube_data:
        # Clear bogus audio_path from existing YouTube data
        existing_youtube_data["audio_path"] = None

        existing_transcription = get_saved_transcription(
            None, is_youtube_video=True, youtube_id=youtube_id, site=site
        )
        if existing_transcription:
            logger.debug(
                "preprocess_youtube_video: Using existing transcription for YouTube video"
            )
            return existing_youtube_data, youtube_id

    # Download if metadata is missing or if we need to transcribe
    youtube_data = download_youtube_audio(url)
    if youtube_data:
        return youtube_data, youtube_id
    else:
        logger.error("Failed to download YouTube video audio.")
        return None, None


def print_report(report):
    logger.info("\nReport:")
    logger.info(f"Files processed: {report['processed']}")
    logger.info(f"Files skipped: {report['skipped']}")
    logger.info(f"Files with errors: {report['errors']}")
    if report["errors"] > 0:
        logger.error("\nError details:")
        for error in report["error_details"]:
            logger.error(f"- {error}")
    if report["warnings"]:
        logger.warning("\nWarnings:")
        for warning in report["warnings"]:
            logger.warning(f"- {warning}")
    print_chunk_statistics(report["chunk_lengths"])


def print_enhanced_chunk_statistics(chunk_lengths):
    """
    Print enhanced chunking statistics.

    For audio/video ingestion, chunk sizes are word-based and configurable via:
    - AUDIO_CHUNK_TARGET_WORDS (default: 300)
    - AUDIO_CHUNK_OVERLAP_WORDS (default: 20% of target)
    """
    if not chunk_lengths:
        print("No chunks to analyze.")
        return

    total_chunks = len(chunk_lengths)
    total_words = sum(chunk_lengths)
    avg_words = total_words / total_chunks
    min_words = min(chunk_lengths)
    max_words = max(chunk_lengths)

    # Target range analysis derived from target (75%–150%)
    try:
        target_words_env = int(os.getenv("AUDIO_CHUNK_TARGET_WORDS", "300"))
    except ValueError:
        target_words_env = 300

    AUDIO_TARGET_MIN = max(1, int(round(target_words_env * 0.75)))
    AUDIO_TARGET_MAX = max(AUDIO_TARGET_MIN, int(round(target_words_env * 1.5)))
    target_range_chunks = sum(
        1 for length in chunk_lengths if AUDIO_TARGET_MIN <= length <= AUDIO_TARGET_MAX
    )
    target_percentage = (target_range_chunks / total_chunks) * 100

    # Distribution analysis for audio chunks
    very_small = sum(1 for length in chunk_lengths if length < AUDIO_TARGET_MIN)
    in_target = target_range_chunks
    large = sum(1 for length in chunk_lengths if length > AUDIO_TARGET_MAX)

    print("📊 Audio Chunk Analysis Summary:")
    print(f"  Total chunks processed: {total_chunks:,}")
    print(f"  Total words processed: {total_words:,}")
    print(f"  Average words per chunk: {avg_words:.1f}")
    print(f"  Range: {min_words} - {max_words} words")
    print()

    print(f"🎯 Target Range Achievement ({AUDIO_TARGET_MIN}-{AUDIO_TARGET_MAX} words):")
    print(
        f"  Chunks in target range: {target_range_chunks:,}/{total_chunks:,} ({target_percentage:.1f}%)"
    )
    print()

    print("📈 Distribution Analysis:")
    print(
        f"  Below target (<{AUDIO_TARGET_MIN} words): {very_small:,} chunks ({very_small / total_chunks * 100:.1f}%)"
    )
    print(
        f"  In target ({AUDIO_TARGET_MIN}-{AUDIO_TARGET_MAX} words):  {in_target:,} chunks ({in_target / total_chunks * 100:.1f}%)"
    )
    print(
        f"  Above target (>{AUDIO_TARGET_MAX} words): {large:,} chunks ({large / total_chunks * 100:.1f}%)"
    )
    print()

    # Quality assessment
    if target_percentage >= 70:
        quality = "Excellent"
        emoji = "🟢"
    elif target_percentage >= 50:
        quality = "Good"
        emoji = "🟡"
    elif target_percentage >= 30:
        quality = "Fair"
        emoji = "🟠"
    else:
        quality = "Needs Improvement"
        emoji = "🔴"

    print(f"{emoji} Chunking Quality: {quality}")

    # Recommendations
    if very_small > total_chunks * 0.1:  # More than 10% below target
        print(
            f"⚠️  High number of small chunks ({very_small}). Consider adjusting chunking parameters."
        )
    if large > total_chunks * 0.1:  # More than 10% above target
        print(
            f"⚠️  Large chunks detected ({large}). Consider adjusting chunking parameters."
        )

    print()


def merge_reports(reports):
    """
    Combines multiple processing reports into a single aggregate report.
    Accumulates counts and concatenates error/warning lists.

    Fixed: Files that get fully_indexed should be counted as 'processed'
    regardless of whether they were initially marked as 'skipped' due to
    using cached transcriptions.
    """
    combined_report = {
        "processed": 0,
        "skipped": 0,
        "errors": 0,
        "error_details": [],
        "warnings": [],
        "fully_indexed": 0,
        "chunk_lengths": [],
        "private_videos": 0,
    }
    for report in reports:
        for key in [
            "processed",
            "skipped",
            "errors",
            "fully_indexed",
            "private_videos",
        ]:
            combined_report[key] += report.get(key, 0)
        combined_report["error_details"].extend(report.get("error_details", []))
        combined_report["warnings"].extend(report.get("warnings", []))
        combined_report["chunk_lengths"].extend(report.get("chunk_lengths", []))

    # Fix counting logic: if files were fully indexed, they should be counted as processed, not skipped
    if combined_report["fully_indexed"] > 0:
        # Files that were fully indexed should be counted as processed
        combined_report["processed"] = combined_report["fully_indexed"]
        # If files were processed, they shouldn't be counted as skipped
        combined_report["skipped"] = 0

    return combined_report


def _parse_arguments():
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description="Audio and video transcription and indexing script",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )

    # Required arguments
    required = parser.add_argument_group("Required Arguments")
    required.add_argument(
        "-s", "--site", required=True, help="Site ID for environment variables"
    )

    # Processing control options
    processing = parser.add_argument_group("Processing Control")
    processing.add_argument(
        "-f",
        "--force",
        action="store_true",
        help="Force re-transcription and re-indexing",
    )
    processing.add_argument(
        "-c",
        "--clear-vectors",
        action="store_true",
        help="Clear existing vectors before processing",
    )
    processing.add_argument(
        "-o",
        "--override-conflicts",
        action="store_true",
        help="Continue processing even if filename conflicts are found",
    )

    # Queue management options
    queue = parser.add_argument_group("Queue Management")
    queue.add_argument(
        "-q",
        "--queue",
        metavar="NAME",
        default=None,
        help="Specify an alternative queue name for parallel processing",
    )

    # Testing and development options
    testing = parser.add_argument_group("Testing & Development")
    testing.add_argument(
        "-D",
        "--dryrun",
        action="store_true",
        help="Perform a dry run without sending data to Pinecone or S3",
    )

    # Debug and logging options
    debug = parser.add_argument_group("Debug & Logging")
    debug.add_argument(
        "-d", "--debug", action="store_true", help="Enable debug logging"
    )

    return parser.parse_args()


def _setup_vector_clearing(args, ingest_queue):
    """Handle vector clearing if requested."""
    if args.clear_vectors:
        try:
            index = load_pinecone()
            # Get unique libraries from queue items
            all_items = ingest_queue.get_all_items()
            libraries = set()
            for item in all_items:
                if item.get("data", {}).get("library"):
                    libraries.add(item["data"]["library"])

            if not libraries:
                logger.warning(
                    "No libraries found in queue items. Skipping vector clearing."
                )
            else:
                for library in libraries:
                    logger.info(f"Clearing vectors for library: {library}")
                    clear_library_vectors(index, library, ask_confirmation=False)
        except Exception as e:
            logger.error(f"Error clearing vectors: {str(e)}")
            if not args.override_conflicts:
                logger.error("Exiting due to error in clearing vectors.")
                sys.exit(1)


def _process_items_with_progress(
    task_queue,
    result_queue,
    items_to_process,
    overall_report,
    ingest_queue,
    num_processes,
    report_container=None,
):
    """Process items with progress tracking."""
    total_items = 0  # Track the total number of items
    items_processed = 0

    # Pre-fill task queue to match worker count for optimal startup
    for _ in range(num_processes):
        item = ingest_queue.get_next_item()
        if not item:
            break
        task_queue.put(item)
        items_to_process.append(item)
        total_items += 1

    # Main processing loop with progress tracking
    with tqdm(total=total_items, desc="Processing items") as pbar:
        while items_processed < total_items:
            try:
                # 5 minute timeout for result processing
                item_id, report = result_queue.get(timeout=300)

                # Update item status and tracking
                if item_id is not None:
                    ingest_queue.update_item_status(
                        item_id,
                        "completed" if report["errors"] == 0 else "error",
                    )
                    # Remove completed item from active tracking
                    items_to_process[:] = [
                        item for item in items_to_process if item["id"] != item_id
                    ]

                # Aggregate results and update progress
                overall_report = merge_reports([overall_report, report])
                items_processed += 1
                pbar.update(1)

                # Update the report container so signal handler can access latest results
                if report_container is not None:
                    report_container["report"] = overall_report

                # Keep task queue filled by adding new items as others complete
                item = ingest_queue.get_next_item()
                if item:
                    task_queue.put(item)
                    items_to_process.append(item)
                    total_items += 1

            except Empty:
                # Log timeout but continue - workers may still be processing
                logger.info(
                    "Main loop: Timeout while waiting for results. Continuing..."
                )

    return overall_report


def _run_worker_pool_processing(args, overall_report):
    """Run the main worker pool processing loop."""
    # Initialize multiprocessing resources
    task_queue = Queue()
    result_queue = Queue()
    stop_event = Event()
    items_to_process = []  # Track active items for cleanup on shutdown

    # Use a mutable container to hold the report so the signal handler can access the latest version
    report_container = {"report": overall_report}

    # Limit processes to prevent resource exhaustion
    num_processes = min(4, cpu_count())
    with Pool(
        processes=num_processes,
        initializer=worker,
        initargs=(task_queue, result_queue, args, stop_event),
    ) as pool:
        # Set up graceful shutdown handlers for clean termination
        def graceful_shutdown(_signum, _frame):
            logger.info("\nReceived interrupt signal. Shutting down gracefully...")
            stop_event.set()
            for _ in range(num_processes):
                task_queue.put(None)
            pool.close()
            pool.join()
            for item in items_to_process:
                ingest_queue.update_item_status(item["id"], "interrupted")

            # Use the latest report from the container
            current_report = report_container["report"]
            print_report(current_report)

            # Print audio chunking statistics on graceful shutdown as well
            if current_report["chunk_lengths"]:
                print("\nAudio Chunking Statistics:")
                print_enhanced_chunk_statistics(current_report["chunk_lengths"])

            reset_terminal()
            sys.exit(0)

        signal.signal(signal.SIGINT, graceful_shutdown)
        signal.signal(signal.SIGTERM, graceful_shutdown)

        ingest_queue = (
            IngestQueue(queue_dir=args.queue) if args.queue else IngestQueue()
        )

        try:
            updated_report = _process_items_with_progress(
                task_queue,
                result_queue,
                items_to_process,
                overall_report,
                ingest_queue,
                num_processes,
                report_container,
            )
            # Update the container with the latest report
            report_container["report"] = updated_report
            overall_report = updated_report
        except Exception as e:
            logger.error(f"Error processing items: {str(e)}")
            logger.exception("Full traceback:")

    return overall_report


def main():
    """
    Main execution flow:
    1. Parse arguments and initialize environment
    2. Set up worker pool and queues
    3. Process items in parallel with progress tracking
    4. Handle graceful shutdown on interrupts
    5. Generate final processing report
    """
    args = _parse_arguments()
    initialize_environment(args)
    ingest_queue = IngestQueue(queue_dir=args.queue) if args.queue else IngestQueue()

    if args.queue:
        logger.info(f"Using queue: {args.queue}")

    logger.info(
        f"Target pinecone collection: {os.environ.get('PINECONE_INGEST_INDEX_NAME')}"
    )
    user_input = input("Is it OK to proceed? (Yes/no): ")
    if user_input.lower() in ["no", "n"]:
        logger.info("Operation aborted by the user.")
        sys.exit(0)

    try:
        _setup_vector_clearing(args, ingest_queue)
    except Exception as e:
        error_msg = str(e)
        # Check for Pinecone plan/region errors
        if (
            "free plan does not support indexes" in error_msg
            or "upgrade your plan" in error_msg
            or "INVALID_ARGUMENT" in error_msg
            or "Bad request" in error_msg
        ):
            logger.error("Pinecone Configuration Error:")
            logger.error(
                "Your current Pinecone plan does not support the configured region."
            )
            logger.error(
                "Please upgrade your Pinecone plan or change the region configuration."
            )
            sys.exit(1)
        else:
            # Re-raise other exceptions
            raise

    overall_report = {
        "processed": 0,
        "skipped": 0,
        "errors": 0,
        "error_details": [],
        "warnings": [],
        "fully_indexed": 0,
        "chunk_lengths": [],
    }

    try:
        overall_report = _run_worker_pool_processing(args, overall_report)
    except Exception as e:
        error_msg = str(e)
        # Check for Pinecone plan/region errors
        if (
            "free plan does not support indexes" in error_msg
            or "upgrade your plan" in error_msg
            or "INVALID_ARGUMENT" in error_msg
            or "Bad request" in error_msg
        ):
            logger.error("Pinecone Configuration Error:")
            logger.error(
                "Your current Pinecone plan does not support the configured region."
            )
            logger.error(
                "Please upgrade your Pinecone plan or change the region configuration."
            )
            sys.exit(1)
        else:
            # Re-raise other exceptions
            raise

    print("\nOverall Processing Report:")
    print_report(overall_report)

    # Print audio chunking statistics
    if overall_report["chunk_lengths"]:
        print("\nAudio Chunking Statistics:")
        print_enhanced_chunk_statistics(overall_report["chunk_lengths"])

    queue_status = ingest_queue.get_queue_status()
    logger.info(f"Final queue status: {queue_status}")

    # Explicitly reset the terminal state
    reset_terminal()


if __name__ == "__main__":
    main()
