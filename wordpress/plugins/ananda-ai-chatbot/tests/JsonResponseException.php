<?php

/**
 * Stands in for wp_send_json_* / check_ajax_referer die paths.
 */
class JsonResponseException extends Error {
    /** @var string */
    public $kind;

    /** @var mixed */
    public $payload;

    /** @var int */
    public $status;

    /**
     * @param string $kind    success|error
     * @param mixed  $payload Data passed to wp_send_json_*
     * @param int    $status  HTTP status
     */
    public function __construct($kind, $payload, $status) {
        $this->kind = $kind;
        $this->payload = $payload;
        $this->status = (int) $status;
        parent::__construct($kind . ' ' . $status);
    }

    /**
     * @return mixed
     */
    public function code() {
        if (is_array($this->payload) && isset($this->payload['code'])) {
            return $this->payload['code'];
        }
        return null;
    }
}
