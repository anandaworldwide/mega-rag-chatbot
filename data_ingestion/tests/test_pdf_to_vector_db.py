import tempfile
from unittest.mock import AsyncMock, patch

import pdf_to_vector_db as pdf_ingestion
import pytest

from data_ingestion.utils.document_hash import generate_document_hash
from data_ingestion.utils.embeddings_utils import OpenAIEmbeddings
from data_ingestion.utils.text_splitter_utils import Document, SpacyTextSplitter


# Pytest fixtures for setup and teardown
@pytest.fixture
def mock_env():
    """Set up mock environment variables."""
    with patch.dict(
        "os.environ",
        {
            "PINECONE_API_KEY": "test-api-key",
            "PINECONE_INGEST_INDEX_NAME": "test-index",
            "OPENAI_INGEST_EMBEDDINGS_MODEL": "text-embedding-ada-002",
            "OPENAI_INGEST_EMBEDDINGS_DIMENSION": "1536",
            "SOURCE_URL": "https://test.com/doc",
            "OPENAI_API_KEY": "test-openai-api-key",
        },
    ):
        yield


@pytest.fixture
def temp_dir():
    """Create a temporary directory for test files."""
    temp = tempfile.TemporaryDirectory()
    pdf_ingestion.file_path = temp.name
    yield temp.name
    temp.cleanup()


# Tests for functions that are still unique to the PDF script
def test_load_env_existing_file():
    """Test loading environment variables from existing file"""
    with (
        patch("os.path.exists", return_value=True),
        patch(
            "pyutil.env_utils.load_dotenv"
        ) as mock_load_dotenv,  # Patch in the module where it's imported
        patch("builtins.print"),  # Suppress print output
    ):
        # Call through the actual function to test the logic
        from pyutil.env_utils import load_env

        result = load_env("test-site")

        mock_load_dotenv.assert_called()  # Should be called with some path
        assert isinstance(result, dict)  # Should return environment dict


def test_load_env_missing_file():
    """Test error when environment file is missing"""
    with patch("os.path.exists", return_value=False), pytest.raises(FileNotFoundError):
        from pyutil.env_utils import load_env

        load_env("test-site")


@pytest.mark.asyncio
async def test_process_document(mock_env):
    """Test processing a single document with spaCy chunking"""
    # Mock the shared utilities and ensure is_exiting returns False
    with (
        patch(
            "data_ingestion.utils.text_splitter_utils.SpacyTextSplitter.split_documents"
        ) as mock_split_documents,
        patch("data_ingestion.utils.progress_utils.is_exiting", return_value=False),
        patch(
            "pdf_to_vector_db.is_exiting", return_value=False
        ),  # Also patch in the module under test
    ):
        # Mock spaCy text splitter response - return chunks with text content
        mock_split_documents.return_value = [
            Document(
                page_content="This is chunk 1 with some meaningful content",
                metadata={
                    "source": "https://test.com/doc",
                    "title": "Test Document",
                    "page": 0,
                },
            ),
            Document(
                page_content="This is chunk 2 with more meaningful content",
                metadata={
                    "source": "https://test.com/doc",
                    "title": "Test Document",
                    "page": 1,
                },
            ),
        ]

        # Note: OpenAI embeddings are now mocked at process_chunk level
        # The actual OpenAI client calls are handled by the mocked process_chunk function

        mock_pinecone_index = AsyncMock()
        mock_embeddings = OpenAIEmbeddings(model="text-embedding-ada-002")

        mock_doc = Document(
            page_content="This is test content. This is more content to make it long enough for chunking.",
            metadata={
                "pdf": {
                    "info": {
                        "Title": "Test Document",
                        "Subject": "https://test.com/doc",
                    }
                },
                "page": 0,
                "source": "https://test.com/doc",  # Add source to metadata
            },
        )

        # Instantiate SpacyTextSplitter
        text_splitter = SpacyTextSplitter()

        # Mock process_chunk to be an async function
        with patch(
            "pdf_to_vector_db.process_chunk", new_callable=AsyncMock
        ) as mock_process_chunk:
            await pdf_ingestion.process_document(
                mock_doc,
                mock_pinecone_index,
                mock_embeddings,
                0,
                "test-library",
                text_splitter,
            )

            # Verify process_chunk was called for each chunk
            assert mock_process_chunk.call_count > 0
            # Should be called once for each chunk returned by split_documents
            assert mock_process_chunk.call_count == 2


@pytest.mark.asyncio
async def test_process_chunk(mock_env):
    """Test processing a single document chunk"""
    # Mock OpenAI embeddings and add shutdown signal mocking
    with (
        patch(
            "data_ingestion.utils.embeddings_utils.OpenAIEmbeddings.embed_query"
        ) as mock_embed_query,
        patch("asyncio.to_thread") as mock_to_thread,
        patch("asyncio.wait_for") as mock_wait_for,
        patch(
            "pdf_to_vector_db.is_exiting", return_value=False
        ),  # Mock shutdown signal
    ):
        # Mock the embed_query method to return a direct value
        mock_embed_query.return_value = [0.1, 0.2, 0.3]

        # Mock wait_for to just return the awaited result
        async def mock_wait_for_func(coro, timeout=None):
            return await coro

        mock_wait_for.side_effect = mock_wait_for_func

        # Mock to_thread to return the embedding value directly for the first call
        async def mock_to_thread_func(func, *args, **kwargs):
            if func == mock_embed_query:
                return [0.1, 0.2, 0.3]
            return await func(*args, **kwargs)

        mock_to_thread.side_effect = mock_to_thread_func

        # Create mock document
        mock_doc = Document(
            page_content="Test content",
            metadata={
                "title": "Test Document",
                "author": "Test Author",
                "source": "https://test.com",
            },
        )

        # Create mock Pinecone index and OpenAIEmbeddings
        mock_pinecone_index = AsyncMock()
        mock_embeddings = OpenAIEmbeddings(model="text-embedding-ada-002")

        # Test the function
        await pdf_ingestion.process_chunk(
            mock_doc, mock_pinecone_index, mock_embeddings, 0, "test-library"
        )

        # Generate expected document hash for verification
        expected_document_hash = generate_document_hash(
            title="Test Document",
            author="Test Author",
            content_type="text",
            chunk_text="Test content",
        )

        # Verify correct ID generation and metadata
        expected_id = f"text||test-library||pdf||Test Document||Test Author||{expected_document_hash}||0"

        expected_metadata = {
            "id": expected_id,
            "library": "test-library",
            "type": "text",
            "author": "Test Author",
            "source": "https://test.com",
            "title": "Test Document",
            "text": "Test content",
            "access_level": "public",
            "required_access_level": 0,
        }

        # Check that wait_for was called (twice: once for embedding, once for upsert)
        assert mock_wait_for.call_count == 2

        # Check that to_thread was called (twice: once for embedding, once for upsert)
        assert mock_to_thread.call_count == 2

        # Verify the first call was for embedding
        first_call_args = mock_to_thread.call_args_list[0]
        embedding_args = first_call_args.args
        assert embedding_args[0] == mock_embeddings.embed_query
        assert embedding_args[1] == "Test content"

        # Verify the second call was for upsert
        second_call_args = mock_to_thread.call_args_list[1]
        upsert_args = second_call_args.args

        # First argument should be the upsert method
        assert upsert_args[0] == mock_pinecone_index.upsert

        # Extract the vectors parameter from kwargs or args
        upsert_kwargs = second_call_args.kwargs
        vectors = upsert_kwargs.get("vectors", None)

        # If vectors is not in kwargs, it might be a positional argument
        if vectors is None and len(upsert_args) > 1:
            vectors = upsert_args[1]

        # Assert that we have vectors data
        assert vectors is not None
        assert len(vectors) == 1

        vector_data = vectors[0]
        assert vector_data[0] == expected_id  # Check ID
        assert vector_data[1] == [0.1, 0.2, 0.3]  # Check embedding
        assert vector_data[2] == expected_metadata  # Check metadata


@pytest.mark.asyncio
async def test_punctuation_preservation_in_pdf_processing(mock_env):
    """Test that PDF processing preserves punctuation through the entire pipeline"""
    with (
        patch(
            "data_ingestion.utils.text_splitter_utils.SpacyTextSplitter.split_documents"
        ) as mock_split_documents,
        patch("data_ingestion.utils.progress_utils.is_exiting", return_value=False),
        patch("pdf_to_vector_db.is_exiting", return_value=False),
    ):
        # Create a document with rich punctuation
        pdf_text_with_punctuation = """
        Chapter 1: Introduction to Meditation
        
        Welcome to this comprehensive guide! Are you ready to begin? 
        Let's explore the fundamentals: breathing, posture, and mindfulness.
        
        Key points to remember:
        • Focus on your breath (inhale... exhale...)
        • Maintain proper posture—straight but relaxed
        • Don't judge your thoughts; simply observe them
        
        "The mind is everything. What you think you become." —Buddha
        
        Mathematical precision: 4 + 4 = 8, but meditation isn't about numbers.
        It's about being present @ this moment, 100% focused.
        
        Questions? Comments? We'll address them in Chapter 2.
        """

        # Mock the text splitter to return chunks that preserve punctuation
        mock_chunks = [
            Document(
                page_content="Chapter 1: Introduction to Meditation\n\nWelcome to this comprehensive guide! Are you ready to begin?",
                metadata={
                    "source": "https://test.com/doc",
                    "title": "Test Document",
                    "page": 0,
                },
            ),
            Document(
                page_content="Let's explore the fundamentals: breathing, posture, and mindfulness.\n\nKey points to remember:\n• Focus on your breath (inhale... exhale...)\n• Maintain proper posture—straight but relaxed\n• Don't judge your thoughts; simply observe them",
                metadata={
                    "source": "https://test.com/doc",
                    "title": "Test Document",
                    "page": 0,
                },
            ),
            Document(
                page_content="\"The mind is everything. What you think you become.\" —Buddha\n\nMathematical precision: 4 + 4 = 8, but meditation isn't about numbers.\nIt's about being present @ this moment, 100% focused.",
                metadata={
                    "source": "https://test.com/doc",
                    "title": "Test Document",
                    "page": 0,
                },
            ),
            Document(
                page_content="Questions? Comments? We'll address them in Chapter 2.",
                metadata={
                    "source": "https://test.com/doc",
                    "title": "Test Document",
                    "page": 0,
                },
            ),
        ]

        mock_split_documents.return_value = mock_chunks

        # Create a mock document with the punctuation-rich text
        mock_doc = Document(
            page_content=pdf_text_with_punctuation,
            metadata={
                "pdf": {
                    "info": {
                        "Title": "Test Document",
                        "Subject": "https://test.com/doc",
                    }
                },
                "page": 0,
                "source": "https://test.com/doc",
            },
        )

        # Mock the process_chunk function to capture the chunks being processed
        processed_chunks = []

        async def mock_process_chunk(
            chunk, pinecone_index, embeddings, chunk_index, library
        ):
            processed_chunks.append(chunk)

        with patch("pdf_to_vector_db.process_chunk", side_effect=mock_process_chunk):
            mock_pinecone_index = AsyncMock()
            mock_embeddings = OpenAIEmbeddings(model="text-embedding-ada-002")
            text_splitter = SpacyTextSplitter()

            await pdf_ingestion.process_document(
                mock_doc,
                mock_pinecone_index,
                mock_embeddings,
                0,
                "test-library",
                text_splitter,
            )

        # Verify that chunks were processed
        assert len(processed_chunks) > 0, "Should have processed at least one chunk"

        # Collect all processed chunk text
        all_chunk_text = " ".join(chunk.page_content for chunk in processed_chunks)

        # Test preservation of various punctuation marks
        punctuation_marks = [
            ":",
            "!",
            "?",
            ".",
            "'",
            '"',
            "(",
            ")",
            "•",
            "—",
            "=",
            "+",
            "@",
        ]

        for mark in punctuation_marks:
            assert mark in all_chunk_text, (
                f"Punctuation mark '{mark}' should be preserved in PDF chunks"
            )

        # Test preservation of contractions and special formatting
        special_elements = ["Let's", "isn't", "Don't", "We'll"]
        for element in special_elements:
            assert element in all_chunk_text, (
                f"Special element '{element}' should be preserved"
            )

        # Verify that each chunk contains meaningful punctuation
        for chunk in processed_chunks:
            chunk_text = chunk.page_content.strip()
            if len(chunk_text) > 10:  # Only check substantial chunks
                # Should contain some punctuation
                has_punctuation = any(char in chunk_text for char in ".,!?;:—")
                assert has_punctuation, (
                    f"PDF chunk should contain punctuation: '{chunk_text[:50]}...'"
                )

        print(
            f"PDF punctuation preservation test passed. Processed {len(processed_chunks)} chunks."
        )
